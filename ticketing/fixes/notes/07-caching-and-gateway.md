# Phase 07: Caching & API Gateways — Architecture & Interview Guide

This guide details the system design, distributed caching patterns, and API gateway architectures implemented in Phase 07 of the Ticketing platform. It is structured specifically for senior backend engineering and system design interviews.

---

## 1. Core Architecture Diagram

```text
       Internet Clients (Browser / Mobile / Bots)
                          │
                          │ HTTPS (:443) / HTTP (:80)
                          ▼
            ┌────────────────────────────┐
            │   Kong API Gateway Pod     │
            │  (DB-less Declarative CRDs)│
            └─────────────┬──────────────┘
                          │
         ┌────────────────┼────────────────┐
         │ (100 req/min)  │ (10 req/min)   │ (100 req/min)
         │ 1MB max payload│ CORS Injection │
         ▼                ▼                ▼
   ┌───────────┐    ┌───────────┐    ┌───────────┐
   │client-srv │    │ auth-srv  │    │tickets-srv│
   │ (Next.js) │    │ (Node.js) │    │ (Node.js) │
   └─────┬─────┘    └───────────┘    └─────┬─────┘
         │                                 │
         │ SSR Internal Proxy Call         │ Cache-Aside Pattern
         │ (kong-proxy.kong.svc)           ▼
         │                          ┌─────────────┐
         │                          │tickets-redis│
         │                          │(allkeys-lru)│
         │                          └──────┬──────┘
         │ (10 req/min per user)           │ Cache Miss
         ▼                                 ▼
   ┌───────────┐                    ┌─────────────┐
   │orders-srv │                    │tickets-mongo│
   │ (Node.js) │                    │(Replica Set)│
   └─────┬─────┘                    └─────────────┘
         │
         │ Atomic INCR / EXPIRE
         ▼
   ┌─────────────┐
   │orders-redis │
   │(Anti-Scalp) │
   └─────────────┘
```

---

## 2. API Gateway: Kong DB-less vs Ingress-NGINX

### 2.1 The Problem with Ingress-NGINX at Enterprise Scale
1. **Monolithic Lua / Regex Configuration**: Ingress-NGINX generates a massive, single `nginx.conf` file inside the controller pod. Every change to any Ingress resource triggers an NGINX config reload (`nginx -s reload`). During peak load or frequent deployments, reload loops drop active TCP connections and introduce CPU spikes.
2. **Lack of Native API Management**: Ingress-NGINX is a reverse proxy, not an API gateway. Features like per-route rate limiting, consumer authentication, request size enforcement, and transformation require complex regex snippets or non-standard lua modules.
3. **Fragile Annotations**: Configuration is injected via unstructured string annotations (`nginx.ingress.kubernetes.io/configuration-snippet`), which lack Kubernetes schema validation and type safety.

### 2.2 Why Kong Gateway in DB-less Mode?
1. **Declarative Custom Resource Definitions (CRDs)**: Kong exposes its capabilities as first-class Kubernetes CRDs (`KongPlugin`, `KongClusterPlugin`, `KongConsumer`). Changes are strictly validated by the Kubernetes API server before admission.
2. **Zero Database Dependency (DB-less)**: Traditional Kong required a shared PostgreSQL cluster to store routing state, adding operational overhead and a single point of failure. Kong Ingress Controller in DB-less mode loads configuration entirely into memory via Kubernetes ConfigMaps and CRDs.
3. **High-Performance In-Memory Routing**: Built on OpenResty and LuaJIT, Kong processes incoming HTTP requests in sub-millisecond proxy latency (measured at < 1ms) while applying rate-limiting, CORS, and request-size inspection before traffic touches downstream microservices.

### 2.3 Layer 7 Rate Limiting vs Layer 4 Rate Limiting
- **Layer 4 (L4 / Network)**: Operates at IP/TCP packet level (e.g., iptables, AWS Network Load Balancer). Cannot inspect HTTP headers, JWT tokens, cookies, or route paths.
- **Layer 7 (L7 / Application - Kong)**: Inspects HTTP methods, URIs, and headers. Can enforce 100 req/min globally, but restrict `/api/users/*` to 10 req/min to prevent brute-force credential stuffing.

---

## 3. Distributed Caching Patterns

### 3.1 Cache-Aside (Lazy Loading)
- **Algorithm**:
  1. The application receives a read request (`GET /api/tickets/:id`).
  2. The application checks the cache (`tickets-redis`).
  3. **Cache Hit**: Returns cached JSON immediately.
  4. **Cache Miss**: Queries the database (`tickets-mongo`), stores the result in Redis with an expiration TTL, and returns the response.
- **Failure Modes & Defense**:
  - **Cache Stampede (Thundering Herd)**: When a popular key expires, thousands of concurrent requests all miss the cache simultaneously and slam MongoDB.
    - *Defense*: **TTL Jitter**. We randomize the TTL by ±10% (e.g., `baseTtl * (1 + (Math.random() * 0.2 - 0.1))`). This ensures concurrently cached keys desynchronize their expiration times.
  - **Stale Data on Write**: Updating the database without invalidating the cache leaves stale data until TTL expiry.
    - *Defense*: **Post-Commit Invalidation**. Immediately after a write transaction commits (`session.commitTransaction()`), call `redis.del(key)`. Never delete the cache key *before* commit, because concurrent reads will fetch old data and re-cache it before the write commits!
  - **Cache Outage (Fail-Open)**: If Redis crashes or network partitions, the application must catch the Redis error, log a warning, and fetch directly from MongoDB without failing the HTTP request.

### 3.2 Database-per-Service in Caching
- **Anti-Pattern**: A shared Redis instance across all microservices. This creates an unmonitored backchannel between services, introduces noisy-neighbor contention (e.g., `orders` eviction evicting `tickets` catalog), and violates service autonomy.
- **Best Practice**: Dedicated Redis deployment per service:
  - `tickets-redis-srv`: Dedicated to ticket catalog and item caching.
  - `orders-redis-srv`: Dedicated to anti-scalping rate-limiting counters.
  - `expiration-redis-srv`: Dedicated to BullMQ delayed reservation sweeps.

---

## 4. Cursor-Based Pagination vs Offset-Based Pagination

### 4.1 The Offset Pagination Trap (`skip` / `limit`)
```javascript
// Query:
Ticket.find().skip(100000).limit(20);
```
- **Performance Degradation ($O(N)$)**: MongoDB must scan through 100,000 documents, load them into RAM, and discard them before returning the 20 requested records. At scale, this causes high disk I/O, cache thrashing, and slow responses.
- **Pagination Drift**: If a new ticket is inserted while a user is paginating, the offset shifts. The user sees duplicate records on subsequent pages or misses records completely.

### 4.2 Cursor-Based Pagination ($O(1)$)
```javascript
// Query using MongoDB natural index (_id):
Ticket.find({ _id: { $gt: cursorObjectId } }).sort({ _id: 1 }).limit(limit);
```
- **Constant Time ($O(\log N)$ B-tree index lookup)**: MongoDB seeks directly to the cursor `_id` in the index and reads exactly `limit` documents.
- **Zero Drift**: Even if 1,000 tickets are inserted concurrently, the cursor points to a fixed position in the monotonic ID sequence.
- **Payload Contract**:
  ```json
  {
    "tickets": [...],
    "nextCursor": "6ad37a10df54d1b453c48241"
  }
  ```

---

## 5. Layered Anti-Scalping Rate Limiting

Ticket scalping and flash sale abuse require a defense-in-depth approach across multiple layers:

| Layer | Component | Rate Limit Key | Limit | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| **Edge Gateway** | Kong Gateway | Client IP | 100 req/min | Protects cluster infrastructure against DDoS and volumetric scraping |
| **Auth Gateway** | Kong Gateway | Client IP | 10 req/min | Prevents credential stuffing and automated account generation bots |
| **Application L7** | Orders Service | `req.currentUser.id` | 10 orders/min | Prevents authenticated scalper bots from spinning up multi-IP checkout attacks |

### Why Edge Rate Limiting Alone Is Insufficient
Professional scalpers rotate through hundreds of residential proxies (different IP addresses per request). Kong's IP-based rate limiting sees each request from a distinct IP and lets it through.
However, in our Orders service, checkout requires authentication (`requireAuth`). The orders rate limiter keys on the authenticated user ID (`ratelimit:orders:${userId}`). Regardless of how many rotating proxy IPs the scalper uses, all requests funnel into the same user counter in `orders-redis`, triggering HTTP 429 when quota is exceeded!

---

## 6. Interview Questions & Model Answers

### Q1: Why did you choose Kong in DB-less mode instead of Kong with PostgreSQL?
> **Answer**: Kong with PostgreSQL introduces an external stateful database dependency. For Kubernetes-native microservices, state should reside in version-controlled Git manifests (GitOps). Kong DB-less mode stores routing rules, consumers, and plugins directly in memory, configured declaratively via Kubernetes CRDs (`KongPlugin`, `Ingress`). This eliminates database maintenance, database failover risks, and connection pool bottlenecks at the gateway layer.

### Q2: What is the Thundering Herd problem and how did you prevent it?
> **Answer**: The Thundering Herd (or cache stampede) occurs when a popular cache key (e.g. the first page of concert tickets) expires. Hundreds of concurrent client requests miss the cache at that exact instant and hit the database simultaneously, causing connection exhaustion and latency spikes. We prevented this by adding a **±10% randomized TTL jitter** to all cached keys. This staggers the expiration times of cache keys, smoothing database read pressure.

### Q3: Why should cache invalidation happen after transaction commit, rather than before?
> **Answer**: If you invalidate the cache before `session.commitTransaction()`, a concurrent client read request can execute between the deletion and the commit. That read query fetches uncommitted (or old) data from MongoDB and re-populates the cache with stale data. By placing `ticketCache.invalidate()` strictly after `session.commitTransaction()`, we guarantee that any subsequent cache miss will read only committed, authoritative state.

### Q4: How does cursor-based pagination prevent pagination drift?
> **Answer**: In offset-based pagination (`skip: 20, limit: 10`), if an item is inserted on page 1 while the user navigates to page 2, all records shift down by one position. The user sees the last record of page 1 again on page 2 (drift). In cursor-based pagination, the query requests items where `_id > afterCursor`. Because MongoDB `ObjectId` values are strictly ordered and immutable, newly inserted records elsewhere never alter the query boundary of the current page.
