# Phase 07 — Caching & API Gateway (Redis Cache, Pagination, Kong, Rate Limiting)

**Goal:** Make the read-heavy path (browsing tickets) fast and cheap, and protect the system at the edge from abuse:
brute-force logins, scalping bots and request floods.

**Grouped because:** both are about **traffic**: serving it cheaply (cache, pagination) and controlling it (gateway,
rate limits). Both are measured with the same load tests.

---

## 1. Problems

| # | Problem | Where | Impact |
|---|---|---|---|
| 1 | `GET /api/tickets` returns **every** unreserved ticket | [tickets/src/routes/index.ts](../tickets/src/routes/index.ts) line 7 | Response size and latency grow without limit |
| 2 | Every browse hits Mongo | same | Reads compete with writes during a flash sale |
| 3 | No rate limiting anywhere | ingress, auth | Password brute force, bots buying every ticket |
| 4 | Ingress-NGINX only routes | [ingress-srv.yaml](../infra/k8s/ingress-srv.yaml) | No central place for limits, CORS, size limits |

---

## 2. Pagination (Do This Before Caching)

Caching an unbounded list just caches a problem. **Cursor-based** pagination:

```text
GET /api/tickets?limit=20                 → { tickets: [...20], nextCursor: "65f1..." }
GET /api/tickets?limit=20&after=65f1...   → next 20
```

```ts
const limit = Math.min(Number(req.query.limit) || 20, 100);
const filter: any = { orderId: undefined };
if (req.query.after) {
    filter._id = { $gt: req.query.after };
}

const tickets = await Ticket.find(filter).sort({ _id: 1 }).limit(limit);
const nextCursor = tickets.length === limit ? tickets[tickets.length - 1].id : null;

res.send({ tickets, nextCursor });
```

| | Offset (`?page=5`) | Cursor (chosen) |
|---|---|---|
| Deep pages | Slow (`skip` scans) | Constant, uses the `_id` index |
| Items added or removed while paging | Duplicates / skipped items | Stable |

The client landing page ([client/app/page.js](../client/app/page.js)) gets a "Load more" button.

---

## 3. Redis Cache (Cache-Aside)

### What to cache
| Endpoint | Cache? | Why |
|---|---|---|
| `GET /api/tickets` (first page) | ✅ TTL 30s | The hottest endpoint, the same for every user |
| `GET /api/tickets/:id` | ✅ TTL 60s | Ticket detail page during a flash sale |
| Deep pages | ❌ | Low hit rate, not worth the invalidation complexity |
| Anything in orders / payments | ❌ | User-specific and correctness-critical |

### Read path
```text
 GET /api/tickets/:id
    │
    ├─► Redis GET ticket:{id} ── hit ──► return (Mongo not touched)
    │
    └── miss ──► Mongo findById ──► Redis SET ticket:{id} EX 60 ──► return
```

### Invalidation: the tickets service owns the data, so it invalidates
| Write | Invalidate |
|---|---|
| Ticket created (route) | `tickets:list` |
| Ticket updated (route) | `ticket:{id}`, `tickets:list` |
| Ticket reserved / released (Order listeners) | `ticket:{id}`, `tickets:list` |

Invalidation happens **after** the Mongo transaction commits (deleting before commit lets another request re-cache the
old value). If the delete fails, the TTL is the safety net, which is why TTLs are short.

### Code
`tickets/src/services/ticket-cache.ts`: one small file with clearly named functions:
```ts
export const ticketCache = {
    async get(id: string) { /* GET ticket:{id} → JSON.parse or null */ },
    async set(ticket: TicketDoc) { /* SET ticket:{id} EX 60 */ },
    async getList() { /* GET tickets:list */ },
    async setList(payload: object) { /* SET tickets:list EX 30 */ },
    async invalidate(id?: string) { /* DEL ticket:{id} + tickets:list */ }
};
```
Routes call `ticketCache.get(...)` before Mongo, just like a normal function call. No decorators, no magic middleware.

### Failure policy: the cache must never take the service down
If Redis is down → log a warning, read from Mongo. Cache errors are caught inside `ticket-cache.ts`, so routes never see them.
The `ioredis` client is configured with `maxRetriesPerRequest: 1` and a short `connectTimeout`, so a dead Redis doesn't add latency.

### Cache stampede
When a hot key expires, hundreds of requests miss at once and all hit Mongo. Mitigations:
- **TTL jitter** (60s ± 10%), so keys don't all expire together. Implemented.
- Request coalescing / "single-flight": explained in notes, not implemented (the TTL is short and the data is small).

### Infrastructure
`infra/k8s/tickets-redis-statefulset.yaml`: a separate Redis per service, consistent with "database per service".
No persistence needed, since a cache can be rebuilt. Env `REDIS_HOST` in `tickets-depl.yaml`.

---

## 4. API Gateway — Kong

### Why replace Ingress-NGINX with Kong
| Need | Ingress-NGINX | Kong |
|---|---|---|
| Path routing | ✅ | ✅ |
| Rate limiting per route / consumer | Basic annotations | ✅ Plugin, configurable per route |
| Request size limit, CORS, bot detection | Partial | ✅ Plugins |
| Interview value | Low | "API Gateway pattern" |

**Kong Ingress Controller** in DB-less mode: routes and plugins are plain Kubernetes YAML (`Ingress` + `KongPlugin` CRDs),
so the setup stays declarative and lives in `infra/k8s/`.

### Install (one-time, documented in `infra/k8s/gateway/README.md`)
```powershell
helm repo add kong https://charts.konghq.com
helm install kong kong/ingress -n kong --create-namespace
```
Ingress-NGINX is uninstalled afterwards.

### Routes
`ingress-srv.yaml` → `ingressClassName: kong`, and the regex paths become simple `Prefix` paths
(`/api/payments`, `/api/users`, `/api/tickets`, `/api/orders`, `/`). Easier to read than regex.

### Plugins (`infra/k8s/gateway/plugins.yaml`)
| Plugin | Applied to | Config | Purpose |
|---|---|---|---|
| `rate-limiting` (global) | all routes | 100 req/min per IP | Flood protection |
| `rate-limiting` (strict) | `/api/users/signin`, `/api/users/signup` | 5 req/min per IP | **Brute force** |
| `request-size-limiting` | all | 1 MB | Payload abuse |
| `cors` | `/api/*` | `https://ticketing.dev` only | Browser security |

Over the limit → **429 Too Many Requests** with a `Retry-After` header.

### Critical gotcha: SSR base URL
[client/api/build-client.js](../client/api/build-client.js) line 12 hardcodes
`ingress-nginx-controller.ingress-nginx.svc.cluster.local`. After the switch, server-side rendering breaks.
Fix: read it from an env var `INGRESS_URL` set in `client-depl.yaml` (value: `http://kong-gateway-proxy.kong.svc.cluster.local`),
so the next gateway change is a YAML-only change.

---

## 5. Per-User Rate Limiting (Anti-Scalping)

Kong sees IPs, but bots rotate IPs. They do **not** rotate accounts as easily. Kong can't read our user id from the
cookie-session JWT without custom plugins, so per-user limiting lives in the service that knows the user:

`orders`: `POST /api/orders` → **10 orders/min per user**, using `express-rate-limit` + `rate-limit-redis`:
```ts
export const orderRateLimit = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    keyGenerator: (req) => req.currentUser!.id,
    store: new RedisStore({ sendCommand: (...args) => redis.call(...args) })
});
```
Placed after `requireAuth` in [orders/src/routes/new.ts](../orders/src/routes/new.ts). A Redis store is needed so the limit
holds across all orders replicas. Orders uses its own small Redis (`orders-redis`), following the same per-service rule.

| Layer | Key | Stops |
|---|---|---|
| Kong (edge) | IP | Floods, brute force, cheap scrapers |
| Orders service | userId | Scalpers with many IPs and one account |

---

## 6. Tests

| Test | Where |
|---|---|
| Pagination: limit, cursor, max 100, `nextCursor` null on the last page | `tickets/src/routes/__test__/index.test.ts` |
| Cache hit skips Mongo, miss populates Redis | tickets (ioredis-mock) |
| Update / reserve invalidates the keys | tickets |
| Redis down → still returns data from Mongo | tickets |
| 11th order in a minute → 429 | orders |

---

## 7. Verification

| Scenario | Phase 00 baseline | Expected |
|---|---|---|
| `browse-load.js` (500 tickets, 200 VUs) | p95 = ? ms, RPS = ? | **p95 ↓ significantly**, RPS ↑, Mongo CPU ↓ |
| Cache hit ratio during the run | n/a | > 90% (add `cache_hits_total` / `cache_misses_total` from Phase 06) |
| New `scenarios/brute-force-login.js`: 50 signin attempts/min from one IP | all hit auth | 5 pass, **rest 429** |
| New `scenarios/scalper-bot.js`: 1 user, 50 orders/min | all accepted | 10 pass, **rest 429** |
| Kill tickets-redis during browse load | n/a | No errors, latency returns to baseline |

Record in `results/phase-07-caching-gateway.md`.

---

## 8. Interview Angle

- **Cache-aside vs write-through vs write-behind**, and why cache-aside fits here.
- **Invalidation ordering**: after commit, and why TTL is still needed. "There are only two hard things..."
- **Cache stampede / thundering herd**: jitter, single-flight, early refresh.
- **Offset vs cursor pagination.**
- **API Gateway pattern**: cross-cutting concerns at the edge vs in services.
- **Rate limiting algorithms**: fixed window, sliding window, token bucket. Which one Kong and express-rate-limit use.
- **Layered rate limiting**: IP at the edge, identity in the service.

---

## 9. Checklist

- [ ] Concept lesson written in `fixes/lessons/07-caching-and-api-gateways.md`, taught & discussed in detail, and explicit go-ahead signal received from developer
- [ ] Cursor pagination in tickets + "Load more" in client
- [ ] tickets-redis + `ticket-cache.ts`, cache on index + show, invalidation after commit, TTL jitter, fail-open
- [ ] Kong installed, ingress migrated to `Prefix` paths, NGINX removed
- [ ] Kong plugins: global + strict auth rate limits, size limit, CORS
- [ ] `build-client.js` uses `INGRESS_URL`
- [ ] orders-redis + per-user order rate limit
- [ ] Tests + verification complete, results recorded
- [ ] `notes/07-caching-and-gateway.md` written
