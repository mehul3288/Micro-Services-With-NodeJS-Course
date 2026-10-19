# Phase 07: Caching & API Gateway Results

## 1. Executive Summary
Phase 07 transitioned the Ticketing platform from a monolithic reverse proxy (Ingress-NGINX) to an enterprise-grade **Kong Gateway** in DB-less mode, implemented **Redis Cache-Aside** with jittered TTL and fail-open resilience, added **Cursor-Based Pagination** for high-performance catalog browsing, and deployed **Layered Anti-Scalping Rate Limiting** at both the gateway IP level and application user level.

---

## 2. Architectural Transformations

### 2.1 Kong Gateway (DB-less Mode with Declarative CRDs)
- **Deployment**: Replaced Ingress-NGINX with Kong Ingress Controller + Kong Proxy v3.4.2 in namespace `kong`.
- **Zero-Breakage SSR Architecture**: Next.js server-side rendering (`client/api/build-client.js`) dynamically routes through `http://kong-proxy.kong.svc.cluster.local`, eliminating DNS resolve failure while preserving incoming cookies and headers.
- **Port 80/443 Seamless Switch**: Deconflicted Docker Desktop host port 80/443 bindings by scaling down the legacy ingress controller and routing localhost directly to `kong-proxy`.
- **Declarative Plugins (`KongPlugin` CRDs)**:
  - **Global Rate Limiting**: 100 req/min per IP address (`konghq.com/plugins: global-rate-limit`).
  - **Auth Brute-Force Rate Limiting**: 10 req/min per IP on `/api/users` routes (`konghq.com/plugins: auth-rate-limit`).
  - **Request Size Limiting**: Rejects requests larger than 1MB with `413 Payload Too Large` before payload enters the Node.js event loop (`request-size-limiting`).
  - **CORS Management**: Enforces allowed origin `https://ticketing.dev`, headers, and credentials.

### 2.2 Redis Cache-Aside for Tickets Service
- **Dedicated Cache**: Deployed `tickets-redis-srv` (`redis:7-alpine`) with LRU eviction (`--maxmemory 100mb --maxmemory-policy allkeys-lru`).
- **Thundering Herd / Stampede Protection**: Added ±10% randomized jitter to TTLs:
  - Individual ticket (`ticket:{id}`): 60s base TTL (54s - 66s).
  - Catalog first page (`tickets:list`): 30s base TTL (27s - 33s).
- **Post-Commit Cache Invalidation**: Strictly executes after database transactions commit:
  - `POST /api/tickets`: invalidates `tickets:list`.
  - `PUT /api/tickets/:id`: invalidates `tickets:list` and `ticket:{id}`.
  - `OrderCreatedListener` / `OrderCancelledListener`: invalidates both to keep reservations fresh.
- **Fail-Open Resilience**: All cache reads and writes wrap in try/catch with fallback to MongoDB. Redis outages never crash the service.

### 2.3 Cursor-Based Pagination
- **Query Optimization**: Migrated `GET /api/tickets` from unbounded queries to deterministic, cursor-based pagination using MongoDB `_id` (`{ _id: { $gt: afterObjectId } }`).
- **Payload Structure**: Returns `{ tickets, nextCursor }`.
- **Frontend Integration**: Built `client/components/ticket-list.js` providing seamless "Load More Tickets" client-side cursor pagination.

### 2.4 Layered Anti-Scalping Rate Limiting in Orders
- **Per-User Distributed Quota**: Integrated `orders-redis-srv` backing atomic Redis `INCR` + `EXPIRE`.
- **Enforcement**: Limits checkout creation (`POST /api/orders`) to 10 orders/min keyed by authenticated user ID (`req.currentUser.id`).
- **Standard Headers**: Sets `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset`.
- **Fail-Open**: If Redis fails, orders still succeed without dropping customer checkouts.

---

## 3. End-to-End Live Verification Results

The test suite executed live against the Kubernetes cluster (`scratch/test-phase07-live.js`):

```text
===============================================================================
PHASE 07: KONG GATEWAY & REDIS CACHING END-TO-END VERIFICATION
===============================================================================

--- 1. Kong Gateway Routing & Rate Limit Headers ---
[Status]: 200
[Kong Gateway Via]: kong/3.4.2
[RateLimit-Limit]: 10
[RateLimit-Remaining]: 9
[Access-Control-Allow-Credentials]: true

--- 2. Kong Auth Strict Rate Limiting (Brute-Force Protection) ---
[Request #10] Successfully blocked by Kong: HTTP 429 Too Many Requests! Message: "API rate limit exceeded"
[Retry-After]: 53s
Result: 9 allowed before Kong enforced 429 threshold: true

--- 3. Redis Cache-Aside: Ticket Catalog & Item ---
[Request 1 (Potential Cache Miss)]: Status 200, Latency: 9ms
[Request 2 (Redis Cache Hit)]: Status 200, Latency: 6ms
[tickets-redis Cached Keys]:
tickets:list
ticket:6ad23f1c19040464b9cc58de

--- 4. Kong Request Size Limit Plugin (1MB Payload Protection) ---
[1.5MB Payload Response Status]: 413 (Expected 413 Payload Too Large)
[Response Body]: { message: 'Request size limit exceeded' }

===============================================================================
ALL PHASE 07 GATEWAY & CACHING VERIFICATION TESTS COMPLETE
===============================================================================
```

---

## 4. Test Suite Matrix

| Service | Test Suite | Tests Passed | Status |
| :--- | :--- | :--- | :--- |
| `tickets` | Cursor Pagination (`routes/__test__/index.test.ts`) | 4 / 4 | **PASS** |
| `tickets` | Redis Cache-Aside (`services/__test__/ticket-cache.test.ts`) | 5 / 5 | **PASS** |
| `tickets` | Full Suite (`routes/`, `listeners/`, `models/`) | 32 / 32 | **PASS** |
| `orders` | Anti-Scalping Limiter (`middlewares/__test__/order-rate-limiter.test.ts`) | 4 / 4 | **PASS** |
| `orders` | Full Suite (`routes/`, `listeners/`, `jobs/`, `models/`) | 34 / 34 | **PASS** |
