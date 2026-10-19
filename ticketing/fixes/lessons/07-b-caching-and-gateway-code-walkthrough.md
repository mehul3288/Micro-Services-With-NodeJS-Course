# Phase 07: Complete Code & Architecture Walkthrough (Kong Gateway, Redis Cache-Aside & Rate Limiting)

> **Purpose of this guide:**
> In Phase 07, we transformed our microservices system from a basic reverse-proxy model with unprotected, unbounded database queries into a high-performance, resilient platform capable of handling flash sales and traffic surges.
> This document is your **single, self-contained code & architecture reference**. It walks through every configuration file, line of code, distributed caching pattern, anti-scalping rate limiter, and Kubernetes manifest implemented in this phase.

---

## 1. The Big Picture: Architectural Flow

```text
                                  Internet Traffic
                          (Browser / Mobile / Botnets)
                                       │
                                       │ HTTPS (:443) / HTTP (:80)
                                       ▼
                     ┌───────────────────────────────────┐
                     │         Kong API Gateway          │
                     │  (DB-less Ingress Controller)     │
                     └─────────────────┬─────────────────┘
                                       │
            ┌──────────────────────────┼──────────────────────────┐
            │ [Global IP Limit: 100/m] │ [Auth Limit: 10/min]     │ [Payload Limit: 1MB]
            │ CORS Header Injection    │ Brute-Force Protection   │ 413 Early Rejection
            ▼                          ▼                          ▼
     ┌─────────────┐            ┌─────────────┐            ┌─────────────┐
     │ client-srv  │            │  auth-srv   │            │ tickets-srv │
     │  (Next.js)  │            │  (Node.js)  │            │  (Node.js)  │
     └──────┬──────┘            └─────────────┘            └──────┬──────┘
            │                                                     │
            │ SSR Cluster Call                                    │ Cache-Aside Pattern
            │ (http://kong-proxy.kong.svc)                        ▼
            │                                              ┌─────────────┐
            │                                              │tickets-redis│
            │                                              │(allkeys-lru)│
            │                                              └──────┬──────┘
            │                                                     │
            │                                                     │ Cache Miss
            ▼                                                     ▼
     ┌─────────────┐                                       ┌─────────────┐
     │ orders-srv  │                                       │tickets-mongo│
     │  (Node.js)  │                                       │(Replica Set)│
     └──────┬──────┘                                       └─────────────┘
            │
            │ [Anti-Scalping Limit: 10 orders/min per req.currentUser.id]
            │ Atomic INCR / EXPIRE
            ▼
     ┌─────────────┐
     │orders-redis │
     │(Rate Limits)│
     └─────────────┘
```

---

## 2. Pillar 1: Enterprise Kong API Gateway (DB-less Mode)

### 2.1 The Architectural Transition from Ingress-NGINX to Kong
- **Ingress-NGINX Limitation**: Every route or annotation change modifies a monolithic `nginx.conf` and reloads the NGINX master process (`nginx -s reload`). During peak flash-sale loads, continuous reload loops drop in-flight TCP connections and trigger CPU spikes.
- **Kong DB-less Advantage**: Kong compiles routing trees and plugins in-memory without restarting worker processes. By running in **DB-less mode**, we eliminate the need for an external PostgreSQL database while configuring routing declaratively via standard Kubernetes CRDs.

---

### 2.2 Manifest Walkthrough: `infra/k8s/gateway/`

#### 1. Kong DB-less Deployment & Proxy Service ([`kong-dbless.yaml`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/infra/k8s/gateway/kong-dbless.yaml))
- Deploys Kong Ingress Controller and `proxy-kong` into the `kong` namespace.
- Defines `kong-proxy` service as type `LoadBalancer`, binding to host ports 80 and 443 on Docker Desktop (`EXTERNAL-IP: localhost`).
- Registers the official `IngressClass` named `kong`.

#### 2. Declarative Plugins & Ingress Rules ([`infra/k8s/ingress-srv.yaml`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/infra/k8s/ingress-srv.yaml))
We replaced the legacy Ingress-NGINX manifest (`ingress-srv.yaml`) directly with our Kong plugins and ingress routing declarations, allowing Skaffold to manage routing seamlessly:

```yaml
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: global-rate-limit
  namespace: default
config:
  minute: 100
  policy: local
  fault_tolerant: true
  hide_client_headers: false
plugin: rate-limiting
---
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: auth-rate-limit
  namespace: default
config:
  minute: 10
  policy: local
  fault_tolerant: true
  hide_client_headers: false
plugin: rate-limiting
---
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: global-request-size-limit
  namespace: default
config:
  allowed_payload_size: 1 # In Megabytes
plugin: request-size-limiting
---
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: global-cors
  namespace: default
config:
  origins:
    - https://ticketing.dev
    - http://ticketing.dev
  methods:
    - GET
    - POST
    - PUT
    - PATCH
    - DELETE
    - OPTIONS
  credentials: true
  max_age: 3600
plugin: cors
```

- `fault_tolerant: true`: If a plugin encounters an internal error, it fails open to prevent outages.
- `allowed_payload_size: 1`: Rejects oversized requests (> 1MB) immediately with HTTP 413, preventing event loop starvation from parsing huge JSON payloads in Express.

#### 3. Kong Ingress Routing Rules ([`infra/k8s/ingress-srv.yaml`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/infra/k8s/ingress-srv.yaml))
We split routing into two clear Ingress declarations sharing the same hostname (`ticketing.dev`):
1. **`kong-ingress-auth`**: Dedicated to `/api/users`, annotated with `auth-rate-limit` (10 req/min per IP) to prevent credential stuffing.
2. **`kong-ingress-main`**: Routes `/api/tickets`, `/api/orders`, `/api/payments`, and `/` with `global-rate-limit` (100 req/min per IP).
- **The Strip-Path Rule**: Annotated with `konghq.com/strip-path: "false"`. This guarantees that Kong preserves the `/api/...` prefix so Express routes receive the exact URL paths they register.

---

### 2.3 Solving Next.js Server-Side Rendering (SSR) DNS Breakage
In Next.js App Router, pages rendered on the server must call internal APIs to pre-render HTML before sending it to the client browser.
In [`client/api/build-client.js`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/client/api/build-client.js):

```javascript
import axios from 'axios';
import { headers } from 'next/headers';

export default async function buildClient() {
  if (typeof window === 'undefined') {
    // Server-side (SSR) execution
    const headersList = await headers();
    const cookie = headersList.get('cookie');

    return axios.create({
      baseURL:
        process.env.INGRESS_URL ||
        'http://kong-proxy.kong.svc.cluster.local', // Routes cleanly to Kong proxy service
      headers: {
        'X-Forwarded-Proto': headersList.get('x-forwarded-proto') || 'https',
        Host: headersList.get('host') || 'ticketing.dev',
        Cookie: cookie ? decodeURIComponent(cookie) : undefined,
      }
    });
  } else {
    // Client-side browser execution (relative URL)
    return axios.create({
      baseURL: '/',
    });
  }
}
```

- When Ingress-NGINX was removed, the legacy hardcoded URL `ingress-nginx-controller.ingress-nginx.svc.cluster.local` threw `ENOTFOUND`.
- By pointing to `http://kong-proxy.kong.svc.cluster.local`, the Next.js pod resolves Kong directly through CoreDNS. Incoming authentication cookies and host headers are transparently forwarded.

---

## 3. Pillar 2: Redis Cache-Aside for Tickets Service

### 3.1 Dedicated Redis Deployment ([`infra/k8s/tickets-redis-depl.yaml`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/infra/k8s/tickets-redis-depl.yaml))
- Service name: `tickets-redis-srv:6379`.
- Image: `redis:7-alpine`.
- Arguments: `["redis-server", "--maxmemory", "100mb", "--maxmemory-policy", "allkeys-lru"]`.
- When cache fills up, Redis automatically evicts Least Recently Used (LRU) keys rather than rejecting writes with Out-Of-Memory errors.

---

### 3.2 The Resilient Cache Service ([`tickets/src/services/ticket-cache.ts`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/tickets/src/services/ticket-cache.ts))

#### 1. In-Memory Mocking in Test Environment
```typescript
let redisClient: Redis;

if (process.env.NODE_ENV === "test") {
    const RedisMock = require("ioredis-mock");
    redisClient = new RedisMock();
} else {
    redisClient = new Redis({
        host: process.env.REDIS_HOST || "localhost",
        port: Number(process.env.REDIS_PORT) || 6379,
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
        enableReadyCheck: false,
        lazyConnect: true,
    });
}
```
In unit tests, `ioredis-mock` provides a fast, in-memory implementation without needing a live Redis server.

#### 2. Thundering Herd (Cache Stampede) Prevention via TTL Jitter
```typescript
const calculateJitteredTtl = (baseSeconds: number): number => {
    const jitterPercent = (Math.random() * 0.2 - 0.1); // between -10% and +10%
    return Math.round(baseSeconds * (1 + jitterPercent));
};
```
- A static TTL of 60 seconds causes all keys loaded during a traffic burst to expire at the exact same instant (e.g. at $T = 60s$), triggering a massive query wave against MongoDB.
- Adding ±10% jitter spreads out key expiration times (54s to 66s), smoothing database read pressure.

#### 3. Fail-Open Safe Execution
```typescript
async get(id: string): Promise<any | null> {
    try {
        const data = await redisClient.get(`ticket:${id}`);
        if (!data) return null;
        return JSON.parse(data);
    } catch (err: any) {
        console.warn(`[TicketCache] Failed to get ticket:${id}:`, err.message);
        return null; // Fallback to database query
    }
}
```
If Redis network partitions or crashes, `get()` logs a warning and returns `null`. The route proceeds directly to MongoDB without surfacing an error to the user.

---

### 3.3 Cache-Aside in Action: Route Implementations

#### Read Route: Fetch Single Ticket ([`tickets/src/routes/show.ts`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/tickets/src/routes/show.ts))
```typescript
router.get("/api/tickets/:id", async (req: Request, res: Response) => {
    const ticketId = req.params.id as string;

    // 1. Check cache first (sub-millisecond)
    const cachedTicket = await ticketCache.get(ticketId);
    if (cachedTicket) {
        return res.send(cachedTicket);
    }

    // 2. Cache miss: Query MongoDB
    const ticket = await Ticket.findById(ticketId);
    if (!ticket) {
        throw new NotFoundError();
    }

    // 3. Populate cache asynchronously
    ticketCache.set(ticket);

    res.send(ticket);
});
```

#### Read Route: Catalog First Page ([`tickets/src/routes/index.ts`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/tickets/src/routes/index.ts))
When `limit === 20` and `after` cursor is omitted (the default landing page catalog), the service checks `ticketCache.getList()`. If cached, it returns `{ tickets, nextCursor }` immediately.

---

### 3.4 The Post-Commit Invalidation Rule
A critical bug in distributed caching is invalidating the cache **before** the database transaction commits:

```text
[WRONG - Race Condition]:
Thread 1: Starts Mongo transaction (price: 50 -> 100)
Thread 1: Deletes cache key `ticket:123`
Thread 2 (Reader): Cache miss on `ticket:123`
Thread 2 (Reader): Queries Mongo -> reads old committed data (price: 50)
Thread 2 (Reader): Re-populates cache with stale price: 50!
Thread 1: Commits Mongo transaction (price: 100)
Result: Cache now contains stale price: 50 for the entire duration of the TTL!
```

**The Fix: Strict Post-Commit Invalidation**:
In [`tickets/src/routes/update.ts`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/tickets/src/routes/update.ts):
```typescript
let updatedTicket: any;

await mongoose.connection.transaction(async (session) => {
    const ticket = await Ticket.findById(req.params.id).session(session);
    // ... validate & update ...
    await ticket.save({ session });
    await new TicketUpdatedPublisher().publish({...}, session);
    updatedTicket = ticket;
});

// Strictly executed AFTER session commit
if (updatedTicket) {
    await ticketCache.invalidate(updatedTicket.id);
}

res.send(updatedTicket);
```
The same post-commit invalidation pattern is wired into:
- [`tickets/src/routes/new.ts`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/tickets/src/routes/new.ts): calls `ticketCache.invalidate()` to clear `tickets:list`.
- [`order-created-listener.ts`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/tickets/src/events/listeners/order-created-listener.ts): invalidates ticket cache upon reservation.
- [`order-cancelled-listener.ts`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/tickets/src/events/listeners/order-cancelled-listener.ts): invalidates ticket cache upon unreservation.

---

## 4. Pillar 3: Cursor-Based Pagination

### 4.1 Backend Implementation ([`tickets/src/routes/index.ts`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/tickets/src/routes/index.ts))
Instead of using `skip(N)` (which scans and discards $N$ documents in $O(N)$ time), we paginate using MongoDB's natural index on `_id`:

```typescript
router.get("/api/tickets", async (req: Request, res: Response) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 20, 1), 100);
    const after = req.query.after as string | undefined;

    const query: any = { orderId: undefined };

    if (after) {
        if (!mongoose.Types.ObjectId.isValid(after)) {
            throw new BadRequestError("Invalid cursor format");
        }
        query._id = { $gt: new mongoose.Types.ObjectId(after) };
    }

    // O(log N) indexed seek
    const tickets = await Ticket.find(query)
        .sort({ _id: 1 })
        .limit(limit);

    const nextCursor = tickets.length === limit ? tickets[tickets.length - 1].id : null;

    res.send({ tickets, nextCursor });
});
```

- **Query Time**: $O(\log N)$ B-Tree index lookup.
- **Zero Drift**: Adding new tickets does not shift the position of existing pages.
- **Hard Upper Bound**: `Math.min(..., 100)` prevents clients from requesting millions of records at once.

---

### 4.2 Frontend Integration ([`client/components/ticket-list.js`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/client/components/ticket-list.js))
A dynamic React Client Component rendering the ticket catalog with pagination controls:

```javascript
'use client';
import { useState } from 'react';
import Link from 'next/link';
import axios from 'axios';

export default function TicketList({ initialTickets = [], initialCursor = null }) {
  const [tickets, setTickets] = useState(initialTickets);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);

  const loadMore = async () => {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const { data } = await axios.get(`/api/tickets?limit=20&after=${cursor}`);
      setTickets((prev) => [...prev, ...data.tickets]);
      setCursor(data.nextCursor);
    } catch (err) {
      console.error('Failed to load tickets', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <table className="table table-striped table-hover">
        <thead>
          <tr>
            <th>Title</th>
            <th>Price</th>
            <th>Link</th>
          </tr>
        </thead>
        <tbody>
          {tickets.map((ticket) => (
            <tr key={ticket.id}>
              <td>{ticket.title}</td>
              <td>${ticket.price}</td>
              <td>
                <Link href={`/tickets/${ticket.id}`} className="btn btn-primary btn-sm">
                  View
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {cursor && (
        <div className="text-center my-4">
          <button onClick={loadMore} disabled={loading} className="btn btn-outline-primary px-4">
            {loading ? 'Loading...' : 'Load More Tickets'}
          </button>
        </div>
      )}
    </div>
  );
}
```

---

## 5. Pillar 4: Layered Per-User Anti-Scalping Rate Limiter in Orders

### 5.1 Why IP-Based Gateway Limiting Is Not Enough for Scalpers
Professional scalpers distribute their automated purchasing scripts across botnets and rotating residential proxy pools. Every HTTP request arrives at Kong from a distinct IP address, easily bypassing edge IP-based limits (100 req/min).

However, purchasing a ticket requires an authenticated user account (`requireAuth`). By enforcing a second-tier rate limiter in the Orders service keyed on `req.currentUser.id`, the entire botnet is constrained to the same quota regardless of how many proxy IPs it uses.

---

### 5.2 Middleware Implementation ([`orders/src/middlewares/order-rate-limiter.ts`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/orders/src/middlewares/order-rate-limiter.ts))

```typescript
import { Request, Response, NextFunction } from "express";
import { redisClient } from "../services/redis-client";

export interface RateLimiterOptions {
    windowSeconds?: number;
    maxRequests?: number;
}

export const createOrderRateLimiter = (options: RateLimiterOptions = {}) => {
    const windowSeconds = options.windowSeconds || 60;
    const maxRequests = options.maxRequests || 10;

    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        // Anti-scalping is strictly keyed on authenticated user ID
        const identifier = req.currentUser?.id || req.ip || "unknown";
        const key = `ratelimit:orders:${identifier}`;

        try {
            // Atomic Redis counter increment
            const currentRequests = await redisClient.incr(key);

            // Set window expiration on the first request
            if (currentRequests === 1) {
                await redisClient.expire(key, windowSeconds);
            }

            const ttl = await redisClient.ttl(key);
            const remaining = Math.max(0, maxRequests - currentRequests);

            // RFC standard rate-limiting headers
            res.setHeader("RateLimit-Limit", maxRequests);
            res.setHeader("RateLimit-Remaining", remaining);
            res.setHeader("RateLimit-Reset", Math.max(0, ttl));

            // Block request if quota exceeded
            if (currentRequests > maxRequests) {
                res.status(429).send({
                    errors: [
                        {
                            message: "Too many order requests. Anti-scalping rate limit exceeded. Please wait a moment.",
                        },
                    ],
                });
                return;
            }

            next();
        } catch (err: any) {
            // Fail open: Redis outage never stops legitimate checkouts
            console.warn("[OrderRateLimiter] Redis error, failing open:", err.message);
            next();
        }
    };
};

export const orderRateLimiter = createOrderRateLimiter();
```

### 5.3 Route Attachment ([`orders/src/routes/new.ts`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/orders/src/routes/new.ts))
```typescript
router.post(
    "/api/orders",
    requireAuth,      // 1. Authenticate user & attach req.currentUser
    orderRateLimiter, // 2. Enforce 10 orders/min quota on req.currentUser.id
    body("ticketId")  // 3. Validate body & proceed to checkout
        .notEmpty()
        .custom((input: string) => mongoose.Types.ObjectId.isValid(input)),
    validateRequest,
    async (req: Request, res: Response) => {
        // ... checkout transaction ...
    }
);
```

---

## 6. Live Verification Proof & Logs

The verification script executed against the live cluster produced:

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
[Request #10] Successfully blocked by Kong: HTTP 429 Too Many Requests! 
Message: "API rate limit exceeded"
[Retry-After]: 53s
Result: 9 allowed before Kong enforced 429 threshold: true

--- 3. Redis Cache-Aside: Ticket Catalog & Item ---
[Request 1 (Potential Cache Miss)]: Status 200, Latency: 9ms
[Request 2 (Redis Cache Hit)]:       Status 200, Latency: 6ms
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

## 7. Summary of Files Changed & Created

| File | Type | Description |
| :--- | :--- | :--- |
| [`infra/k8s/gateway/kong-dbless.yaml`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/infra/k8s/gateway/kong-dbless.yaml) | Created | Kong Gateway DB-less deployment and proxy LoadBalancer |
| [`infra/k8s/ingress-srv.yaml`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/infra/k8s/ingress-srv.yaml) | Modified | Kong Ingress routing rules & `KongPlugin` CRDs (Replaced legacy Ingress-NGINX) |
| [`client/api/build-client.js`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/client/api/build-client.js) | Modified | Next.js SSR routing through `http://kong-proxy.kong.svc.cluster.local` |
| [`infra/k8s/tickets-redis-depl.yaml`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/infra/k8s/tickets-redis-depl.yaml) | Created | Redis deployment for tickets service with allkeys-lru memory policy |
| [`tickets/src/services/ticket-cache.ts`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/tickets/src/services/ticket-cache.ts) | Created | Resilient Cache-Aside client with ±10% TTL jitter and fail-open handling |
| [`tickets/src/routes/show.ts`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/tickets/src/routes/show.ts) | Modified | Checks cache before Mongo, populates cache on miss |
| [`tickets/src/routes/index.ts`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/tickets/src/routes/index.ts) | Modified | Cursor-based pagination (`_id: { $gt: cursor }`) returning `{ tickets, nextCursor }` |
| [`tickets/src/routes/update.ts`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/tickets/src/routes/update.ts) | Modified | Post-commit cache invalidation (`ticketCache.invalidate`) |
| [`client/components/ticket-list.js`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/client/components/ticket-list.js) | Created | React client component handling cursor "Load More Tickets" |
| [`infra/k8s/orders-redis-depl.yaml`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/infra/k8s/orders-redis-depl.yaml) | Created | Redis deployment for orders service anti-scalping rate limits |
| [`orders/src/middlewares/order-rate-limiter.ts`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/orders/src/middlewares/order-rate-limiter.ts) | Created | Anti-scalping rate limiter middleware keyed on `req.currentUser.id` |
| [`orders/src/routes/new.ts`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/orders/src/routes/new.ts) | Modified | Wires `orderRateLimiter` into the order creation checkout pipeline |
