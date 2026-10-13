# Phase 01 Results: Infrastructure Foundation

**Execution Date:** 2026-10-10  
**Cluster:** Kubernetes (`docker-desktop`)  
**Objective:** Verify data persistence across pod restarts, MongoDB replica set transactions capability, Redis AOF durability, zero-downtime rolling deployments, and liveness/readiness isolation.

---

## 1. Summary of Results

| Test Case | Method | Expected | Actual Result | Status |
|---|---|---|---|---|
| **Replica Set Active** | `mongosh --eval "rs.status().ok"` on all 4 DBs | `1` | `1` on `auth-mongo`, `tickets-mongo`, `orders-mongo`, `payments-mongo` | **PASSED** ✅ |
| **Data Survives Pod Restart** | Create ticket `6aca1331...` → `kubectl delete pod tickets-mongo-0` → `GET /api/tickets` | Ticket exists with full data | Ticket persisted and retrieved successfully | **PASSED** ✅ |
| **Redis AOF Persistence** | Create order → queue 15-min delay job → `kubectl delete pod expiration-redis-0` | Delayed key survives & order cancels | `bull:order:expiration:*` keys survived restart; order cancelled | **PASSED** ✅ |
| **Readiness Isolation (No Cascade)** | Scale `orders-mongo` to 0 replicas | Pod becomes `0/1` NotReady, **0 restarts** | Pod became `0/1` NotReady; `RESTARTS = 0`; healed back to `1/1` upon DB restore | **PASSED** ✅ |
| **Zero-Downtime Rollout** | Run k6 browse load (876 requests) while rolling out `auth`, `tickets`, `orders` | 0 failed requests | `http_req_failed: 0.00%` (0 failed out of 876) | **PASSED** ✅ |

---

## 2. Deep Dive: Test Results & Telemetry

### 2.1 Database Replica Set Status
Ran `rs.status().ok` inside each MongoDB StatefulSet container:
```text
auth-mongo-0:     1 (Primary)
tickets-mongo-0:  1 (Primary)
orders-mongo-0:   1 (Primary)
payments-mongo-0: 1 (Primary)
```
Each MongoDB pod now maintains an internal **Oplog (`local.oplog.rs`)**, enabling multi-document ACID transactions (`session.startTransaction()`) required in Phase 04.

### 2.2 Storage Persistence Verification
1. Created test user and created ticket:
   ```json
   {
     "id": "6aca1331a1d0dd79eb5b9071",
     "title": "Persistent Rock Concert",
     "price": 99,
     "version": 0
   }
   ```
2. Destroyed `tickets-mongo-0`:
   ```bash
   kubectl delete pod tickets-mongo-0
   pod "tickets-mongo-0" deleted
   pod/tickets-mongo-0 condition met
   ```
3. Queried `GET https://ticketing.dev/api/tickets`:
   ```json
   [
     {
       "id": "6aca1331a1d0dd79eb5b9071",
       "title": "Persistent Rock Concert",
       "price": 99,
       "version": 0
     }
   ]
   ```
   **Verdict:** Data survived pod destruction thanks to persistent volume claim `tickets-mongo-storage`.

### 2.3 Redis AOF Job Persistence
1. Created an order `6aca1378df0b248cb9e48039` for ticket `6aca1331a1d0dd79eb5b9071`.
2. Verified Bull queue keys generated in Redis:
   - `bull:order:expiration:delayed`
   - `bull:order:expiration:id`
   - `bull:order:expiration:1`
3. Destroyed Redis pod `expiration-redis-0`:
   ```bash
   kubectl delete pod expiration-redis-0
   pod "expiration-redis-0" deleted
   pod/expiration-redis-0 condition met
   ```
4. Inspected Redis keys after pod recreated:
   - Keys survived restart from `/data/appendonly.aof`.
   - Bull worker fired `expiration:complete` right on schedule.
   - MongoDB order document transitioned from `created` to `cancelled`.

### 2.4 Readiness Probe Failure Isolation
Simulated total database outage by scaling `orders-mongo` to 0:
```text
NAME                           READY   STATUS    RESTARTS   AGE
orders-depl-5889f46d9b-l7642   0/1     Running   0          5m12s
```
- **Observations:**
  - `/healthz/ready` returned `503 Service Unavailable`.
  - Kubernetes immediately detached the pod from Service endpoints so no HTTP traffic was routed to it.
  - `/healthz/live` returned `200 OK` (because the Node process itself was healthy).
  - **Restarts stayed at 0** — no restart loop occurred!
  - Once `orders-mongo` was scaled back to 1, the pod automatically transitioned back to `1/1 Running` with 0 manual intervention and 0 restarts.

### 2.5 Zero-Downtime Rolling Deployment Test
Ran continuous traffic using `k6` while triggering simultaneous rolling restarts across 3 microservices (`auth`, `tickets`, `orders`):
```text
k6 run --vus 5 --duration 20s load-tests/scenarios/browse-load.js
kubectl rollout restart deployment tickets-depl orders-depl auth-depl
```

**Telemetry Output:**
```text
  █ TOTAL RESULTS 

    checks_total.......: 1701    82.07/s
    checks_succeeded...: 100.00% 1701 out of 1701
    checks_failed......: 0.00%   0 out of 1701

    ✓ signup succeeded (201)
    ✓ status is 200
    ✓ response contains tickets

    HTTP
    http_req_duration..............: avg=16.51ms  p(95)=61.11ms max=189.96ms
    http_req_failed................: 0.00%  0 out of 876
    http_reqs......................: 876    42.27/s
```
**Comparison with Phase 00:**
- In Phase 00, rolling deploys dropped 100% of in-flight requests during restart because SIGTERM immediately killed the process without draining.
- In Phase 01, with `preStop: sleep 5` and connection draining (`server.close()`), **0 out of 876 requests failed**.
