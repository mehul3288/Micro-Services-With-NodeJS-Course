# Phase 07: Caching & API Gateways (Redis Cache, Pagination, Kong Gateway & Layered Rate Limiting)

> **Core Theme:** Microservices must handle two opposing traffic challenges:
> 1. **Serving High-Volume Legitimate Traffic Fast and Cheaply:** Making read-heavy endpoints (like browsing tickets during a flash sale) respond in <10ms without crushing the primary database.
> 2. **Defending the System at the Perimeter:** Protecting against abuse, distributed denial-of-service (DDoS), credential stuffing/brute force on auth, and scalping bots purchasing inventory using rotating proxies.

---

## 1. The Anatomy of Flash Sale Traffic & Failure Modes

During a concert ticket drop or high-traffic event:
* **The Read-to-Write Imbalance:** The system experiences a 100:1 to 1000:1 read-to-write ratio. 50,000 users refresh the ticket catalog simultaneously, while only hundreds are placing orders.
* **Database Contention:** If every catalog refresh executes an unindexed or full-table scan on MongoDB (`Ticket.find({ orderId: undefined })`), the database CPU spikes to 100%. Write transactions for actual checkouts stall, leading to connection pool exhaustion and system-wide timeouts.
* **The Bot Threat Model (Scalpers):** 
  - *Layer 1 (Perimeter Flood):* Scripted bots flood endpoints with thousands of requests per second from single or localized IP ranges.
  - *Layer 2 (Credential Stuffing):* Automated dictionary attacks hammer `/api/users/signin` attempting to compromise user accounts.
  - *Layer 3 (Distributed Botnets):* Sophisticated scalpers use residential proxy networks rotating thousands of IP addresses, all authenticated under a few bot accounts to snap up tickets the millisecond they appear.

```text
                               THE LAYERED DEFENSE ARCHITECTURE
                               
   Client Request (Browser / App / Bot)
                │
                ▼
  ┌───────────────────────────────────────────────┐
  │ LAYER 1: EDGE API GATEWAY (Kong)              │  Stops:
  │ • IP Rate Limiting (100 req/min global)       │  - Flood attacks & scrapers
  │ • Strict Auth Rate Limiting (5 req/min on /api/users/signin) │  - Brute force & credential stuffing
  │ • Request Payload Size Limit (1 MB)           │  - Large payload memory exhaustion
  │ • CORS Enforcement                            │  - Unauthorized web origins
  └───────────────────────┬───────────────────────┘
                          │ (Legitimate traffic forwarded to internal cluster)
                          ▼
  ┌───────────────────────────────────────────────┐
  │ LAYER 2: TICKETS SERVICE (Read Optimization)  │  Optimizations:
  │ • Cursor-Based Pagination (?limit=20&after=id)│  - Bounded memory & fast index queries
  │ • Redis Cache-Aside (TTL 30s-60s + Jitter)    │  - 95% of catalog traffic served in <2ms
  │ • Post-Commit Cache Invalidation              │  - Prevents stale cache anomalies
  │ • Fail-Open Policy                            │  - Redis outage never halts the service
  └───────────────────────┬───────────────────────┘
                          │
                          ▼
  ┌───────────────────────────────────────────────┐
  │ LAYER 3: ORDERS SERVICE (Anti-Scalping)       │  Stops:
  │ • Per-User Rate Limiting (10 orders/min/user) │  - Scalper bots rotating residential IPs
  │ • Distributed Redis Rate-Limit Store          │  - Multi-pod cluster enforcement
  └───────────────────────────────────────────────┘
```

---

## 2. Pillar 1: Cursor-Based Pagination (Do This Before Caching!)

### The Trap: Caching Unbounded Lists
In the original implementation:
```typescript
// tickets/src/routes/index.ts (ORIGINAL FLAWED CODE)
const tickets = await Ticket.find({ orderId: undefined });
res.send(tickets);
```
If the database contains 10,000 tickets, this endpoint serializes a multi-megabyte JSON array on every request. **Caching an unbounded array does not solve the problem—it simply caches a memory leak.**

### Offset vs. Cursor Pagination Comparison

| Feature | Offset Pagination (`?page=5&limit=20`) | Cursor Pagination (`?limit=20&after=65f1...`) |
| :--- | :--- | :--- |
| **Database Query** | `Ticket.find(...).skip(80).limit(20)` | `Ticket.find({ _id: { $gt: cursor } }).limit(20)` |
| **Performance at Deep Pages** | **O(N) - Degrades severely.** MongoDB must scan and discard all preceding 80 documents. Page 1,000 scans 20,000 records. | **O(1) - Constant time.** Uses the B-Tree `_id` index directly. Jumping to page 1,000 is as fast as page 1. |
| **Stability Under Concurrent Writes** | **Unstable (Data Drift).** If a ticket is created or purchased on page 1 while a user is on page 2, all items shift. The user sees duplicates or misses items completely. | **Stable.** The cursor is an immutable position marker based on `_id`. Newly inserted items do not shift the cursor boundary. |

### How Cursor Pagination Works in MongoDB:
```typescript
const limit = Math.min(Number(req.query.limit) || 20, 100); // Strict ceiling: max 100
const filter: any = { orderId: undefined };

if (req.query.after) {
    filter._id = { $gt: req.query.after };
}

// O(1) query using the native primary key index
const tickets = await Ticket.find(filter).sort({ _id: 1 }).limit(limit);

const nextCursor = tickets.length === limit ? tickets[tickets.length - 1].id : null;
res.send({ tickets, nextCursor });
```

---

## 3. Pillar 2: Redis Cache-Aside Pattern (Read-Heavy Optimization)

### Cache Topology & Architecture

```text
 GET /api/tickets/:id
        │
        ├─► 1. Query Redis: GET ticket:{id}
        │        │
        │        ├── HIT ──► Return cached JSON immediately (Latency: < 2ms, Mongo untouched)
        │
        └─► 2. MISS
                 │
                 ├── Query MongoDB: Ticket.findById(id)
                 │
                 ├── Populate Redis: SET ticket:{id} EX 60 (with TTL jitter)
                 │
                 └── Return ticket to client
```

### What to Cache vs. What NOT to Cache
* **DO Cache:**
  - `GET /api/tickets` (First page catalog catalog): TTL 30s. The hottest endpoint hit by 99% of browsers.
  - `GET /api/tickets/:id` (Individual ticket details): TTL 60s. High read spikes during ticket browsing.
* **DO NOT Cache:**
  - Deep pagination pages (`?after=...`): Very low cache hit ratio; high memory churn.
  - `orders` and `payments` endpoints: User-specific, transactional, and correctness-critical.

### The 4 Hard Gotchas of Distributed Caching

#### 1. Invalidation Ordering: Always Invalidate AFTER Database Commit
* *The Bug:* If you delete the cache key *before* `session.commitTransaction()`, another concurrent reader might execute `ticketCache.get()`, miss, read the uncommitted/old record from MongoDB, and write the old value back into Redis!
* *The Solution:* Cache invalidation must occur **strictly after** the database transaction commits successfully.

#### 2. The Cache Stampede (Thundering Herd) & TTL Jitter
* *The Bug:* If 1,000 tickets are cached with an exact TTL of `60.00` seconds, they all expire at the exact same millisecond. At second 60, thousands of requests all miss simultaneously and hit MongoDB at once, crashing the database.
* *The Solution:* Apply **TTL Jitter** (e.g., `60s ± 10%`, randomizing expiry between 54s and 66s) so key expirations are evenly distributed over time.

#### 3. Fail-Open Architecture (Resilience Rule)
* *The Rule:* **A cache failure must never take down an application.**
* *Implementation:* If Redis crashes, is out of memory, or has network partitions, the cache client logs a warning and gracefully falls back to querying MongoDB. Routes never crash because of Redis.

#### 4. Cache-Aside vs. Write-Through vs. Write-Behind
* **Cache-Aside (Chosen):** Application code orchestrates reads and writes. The app reads cache first; if miss, reads DB and updates cache. Writes update DB and invalidate cache. (Best for read-heavy workloads where data can be lazily loaded).
* **Write-Through:** Cache acts as the main datastore. Application writes to cache, and cache synchronously writes to DB. (Higher write latency).
* **Write-Behind (Write-Back):** Application writes to cache, and cache asynchronously queues DB writes. (Risk of data loss on cache node crash).

---

## 4. Pillar 3: API Gateway Architecture (Kong Gateway)

### Why Transition from Ingress-NGINX to Kong?
While Ingress-NGINX is a competent reverse proxy, modern microservices require an **API Gateway** capable of executing policy at the edge:

| Capability | Ingress-NGINX | Kong API Gateway |
| :--- | :--- | :--- |
| **Path Routing** | Basic regex matching | High-performance prefix routing |
| **Rate Limiting** | Primitive annotations (global only) | Granular `KongPlugin` CRDs per route/consumer |
| **Payload Protection**| Complex config snippet injection | Native `request-size-limiting` plugin (1MB) |
| **CORS Policy** | Error-prone annotation headers | Native `cors` plugin with explicit origin whitelists |
| **Architecture Value** | Simple Kubernetes ingress | Enterprise **API Gateway Pattern** |

### Declarative DB-less Kong Architecture
We deploy Kong Ingress Controller in **DB-less mode**:
* No PostgreSQL database is required for Kong.
* All routes, services, and plugins are declared as native Kubernetes Custom Resource Definitions (`Ingress` and `KongPlugin`).
* Kong automatically reloads configuration in memory without dropping active TCP connections.

```yaml
# Example: Strict Rate Limiting for Auth Endpoints
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: auth-strict-rate-limit
plugin: rate-limiting
config:
  minute: 5            # Maximum 5 attempts per minute per IP
  policy: local
  hide_client_headers: false
  error_code: 429
  error_message: "Too many login attempts. Please try again in 1 minute."
```

### The SSR Gateway Gotcha (`build-client.js`)
When using Next.js Server-Side Rendering (SSR), server-side requests originate from *inside* the Kubernetes cluster, not the browser.
* *The Issue:* Hardcoding `ingress-nginx-controller.ingress-nginx.svc.cluster.local` breaks immediately when Ingress-NGINX is replaced.
* *The Architectural Fix:* Abstract the internal gateway URL into an environment variable (`INGRESS_URL`), pointing to `http://kong-gateway-proxy.kong.svc.cluster.local`.

---

## 5. Pillar 4: Layered Rate Limiting (Anti-Scalping Strategy)

IP-based rate limiting at the edge is necessary, but **insufficient against professional scalper bots**:
* Scalpers purchase access to residential proxy pools (millions of IPs). Every request arrives from a different IP address, completely bypassing Kong's IP rate limits!
* However, bots **cannot** easily create thousands of authenticated user accounts with verified payment methods.

### The Two-Tiered Solution:
```text
┌────────────────────────────────────────────────────────────────────────┐
│ TIER 1: Edge Rate Limiting (Kong)                                      │
│ • Key: Client IP Address                                               │
│ • Enforced on: ALL Traffic                                             │
│ • Stops: Scraping bots, volumetric floods, brute-force password login  │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ TIER 2: Identity-Based Rate Limiting (Orders Service)                   │
│ • Key: req.currentUser.id (JWT Subject)                               │
│ • Enforced on: POST /api/orders (Checkout path)                        │
│ • Store: Shared Redis Cluster (orders-redis)                           │
│ • Policy: Maximum 10 orders per minute per user account                │
│ • Stops: Scalpers rotating IPs on a single user account                │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 6. Implementation Blueprint for Phase 07

1. **Step 1: Cursor-Based Pagination**
   - Update `tickets/src/routes/index.ts` to accept `limit` and `after`.
   - Update `client/app/page.js` to render pagination and "Load More" controls.
2. **Step 2: Redis Cache for Tickets**
   - Deploy `tickets-redis` (Kubernetes StatefulSet/Deployment).
   - Implement `tickets/src/services/ticket-cache.ts` with cache-aside, TTL jitter, and fail-open.
   - Wire post-commit cache invalidation in ticket create, update, and order reserve/release listeners.
3. **Step 3: Kong API Gateway Deployment**
   - Install Kong Ingress Controller via Helm or declarative manifests.
   - Configure KongPlugins: Global IP rate limit (100 req/min), Auth strict rate limit (5 req/min), Request size limit (1MB), and CORS.
   - Update `client` SSR internal gateway URL.
4. **Step 4: Per-User Anti-Scalping Rate Limiting in Orders**
   - Deploy `orders-redis`.
   - Implement `express-rate-limit` with `rate-limit-redis` keyed on `req.currentUser.id`.
5. **Step 5: Load Testing & Verification**
   - Run k6/Autocannon benchmarks against `GET /api/tickets` to measure p99 latency reduction and database offload.
   - Run brute-force simulation against `/api/users/signin` to verify HTTP 429 response.
   - Run multi-IP scalper simulation against `/api/orders` to verify user-level throttling.
