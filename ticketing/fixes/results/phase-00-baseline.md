# Phase 00 — Baseline & Load Testing Results

Recorded on: **October 10, 2026**  
Testing Engine: **k6 v2.2.0 (Go runtime on Windows)**  
Cluster: **Docker Desktop Kubernetes (`docker-desktop`), NGINX Ingress Controller**

---

## 1. Environment Baseline

| Component | Value | Notes |
|---|---|---|
| OS | Windows 11 AMD64 | Local host |
| Kubernetes | v1.32.2 (Docker Desktop) | Single node cluster |
| Ingress | `ingress-nginx` (v1.x) | Mapped via `ticketing.dev` |
| Services Running | 12 pods (4 App + 4 Mongo + 1 Redis + 1 NATS + 1 Client + 1 Expiration) | Standalone Deployments, no persistent volumes |
| Test Target | `https://ticketing.dev` | `insecureSkipTLSVerify: true` |

---

## 2. Test Scenario Results

### Scenario 1: Double-Payment Vulnerability (`double-payment.js`)
* **Hypothesis:** `payments/src/routes/new.ts` only checks `order.status === Cancelled`, doesn't check `Complete`, lacks a Stripe `idempotencyKey`, and MongoDB has no unique index on `orderId`.
* **Test Method:** 1 User submits a batch of 10 simultaneous payment requests (`http.batch()`) for Order `6ac9ec7d2b5c79dd8e3091fa`.

| Metric | Measured Value | Expected (After Fix in Phase 02) |
|---|---|---|
| Batch Payment Requests | 10 parallel | 10 parallel |
| **HTTP 201 Created** | **10 (100% duplicate charge success)** | **1** |
| HTTP 400 Bad Request | 0 | 9 (rejected) |
| MongoDB Payment Records | **10 records for 1 order ID** | **1 record** |
| Customer Financial Impact | Charged **10x** on credit card | Charged exactly 1x |

**Proof Output from MongoDB:**
```json
[{"_id":"6ac9ec7d2b5c79dd8e3091fa","count":10}]
```

---

### Scenario 2: Flash-Sale Race & Uncaught Exception Crash (`flash-sale-race.js`)
* **Hypothesis:** Concurrent `isReserved()` check-then-act allows multiple orders for 1 ticket.
* **Discovered Critical Finding:** 
  When multiple events or orders hit the services concurrently, the `PaymentCreatedListener` in `orders` throws a Mongoose `VersionError` due to OCC conflict. Because `onMessage()` lacks an unhandled rejection handler or try/catch:
  1. The Node.js process crashed immediately:
     ```text
     VersionError: No matching document found for id "6ac9ec7d2b5c79dd8e3091fa" version 8 modifiedPaths ""
     [nodemon] app crashed - waiting for file changes before starting...
     ```
  2. The Kubernetes pod remained in `1/1 Running` status (no health/readiness probe to detect Node death).
  3. Subsequent orders failed with **HTTP 502 Bad Gateway** because NGINX routed traffic to a dead container.

---

### Scenario 3: Browse Read Performance Baseline (`browse-load.js`)
* **Purpose:** Measure un-cached MongoDB read latency on `GET /api/tickets` to establish a benchmark before implementing the Redis cache in Phase 07.
* **Configuration:** Ramping 0 $\rightarrow$ 20 $\rightarrow$ 50 VUs over 60 seconds against 25 seeded tickets.

| Metric | Baseline Value (Today) |
|---|---|
| Total HTTP Requests Processed | **15,204 requests** |
| Throughput | **252.1 requests/sec** |
| Average Latency | **2.94 ms** |
| Median Latency (p50) | **2.67 ms** |
| **p90 Latency** | **4.06 ms** |
| **p95 Latency (SLA Threshold)** | **4.93 ms** |
| Max Latency | **43.41 ms** |
| Error Rate (`http_req_failed`) | **0.00% (0 / 15,204)** |

---

### Scenario 4: End-to-End Purchase Flow Baseline (`purchase-flow.js`)
* **Purpose:** Measure full user journey latency under concurrent load (Signup $\rightarrow$ Create Ticket $\rightarrow$ Create Order $\rightarrow$ Pay).
* **Configuration:** 20 concurrent VUs over 75 seconds.

| Metric | Value |
|---|---|
| Completed Purchase Flows | **293 flows** |
| Flow Throughput | **3.77 completed checkouts/sec** |
| Total HTTP Calls | **1,465 requests** |
| Step 1: User Signup (Auth) | avg = **37.66 ms** \| p95 = **45.00 ms** |
| Step 2: Create Ticket (Tickets) | avg = **4.40 ms** \| p95 = **6.00 ms** |
| Step 3: Create Order (Orders) | avg = **7.60 ms** \| p95 = **12.00 ms** |
| Step 4: Pay with Stripe (Payments) | avg = **882.25 ms** \| p95 = **1,168.00 ms** |
| Total Iteration Duration | avg = **2.97 s** \| p95 = **3.25 s** |

---

### Scenario 5: Cross-Database Consistency & Chaos Baseline (`checks/consistency.ps1`)
* **Purpose:** Verify data integrity across service boundaries after ungraceful pod termination.
* **Findings:**

```text
Orders DB:   580 total orders, 578 completed orders
Payments DB: 587 total payments (includes 10 duplicate payments for Order 6ac9ec7d2b5c79dd8e3091fa)
Mismatch:    Completed Orders (578) != Recorded Payments (587)
```
* **Failure Mode Exposed:** 
  1. Pod termination during traffic drops active requests because there is no graceful shutdown (`preStop` hook or connection draining).
  2. Duplicated payments permanently desync the financial ledger from the orders ledger.

---

## 3. Summary & What Needs Fixing in Subsequent Phases

| Discovered Vulnerability | Root Cause | Target Fix Phase |
|---|---|---|
| 10 Duplicate Payments on 1 Order | Missing `idempotencyKey` + missing `Complete` check + no unique DB index | **Phase 02 (Correctness & Concurrency)** |
| Nodemon Crash on VersionError | Unhandled rejection in NATS message listeners | **Phase 02 & Phase 03** |
| Dead Pod Served 502s | No Kubernetes `readinessProbe` / `livenessProbe` | **Phase 01 (Infrastructure Foundation)** |
| Data Loss on Pod Restarts | Standalone MongoDB deployments without PVCs | **Phase 01 (Infrastructure Foundation)** |
| In-flight Requests Dropped on Pod Kill | Immediate `process.exit()` without draining | **Phase 01 (Infrastructure Foundation)** |
