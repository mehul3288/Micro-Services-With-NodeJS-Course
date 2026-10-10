# Ticketing Load Test Suite (k6)

This directory contains repeatable load, stress, and concurrency test scenarios for the ticketing microservices architecture.

---

## Prerequisites

1. **k6 installed:**
   ```powershell
   winget install k6 --source winget
   ```
2. **Kubernetes cluster running:**
   ```powershell
   kubectl get pods
   ```
3. **Hosts mapped:**
   Ensure `127.0.0.1 ticketing.dev` is present in `C:\Windows\System32\drivers\etc\hosts`.

---

## Scenarios

### 1. Flash-Sale Race Condition (`scenarios/flash-sale-race.js`)
* **Purpose:** Proves the check-then-act bug in `orders/src/routes/new.ts` when multiple users purchase the same ticket concurrently.
* **Execution:**
  ```powershell
  k6 run scenarios/flash-sale-race.js
  ```
* **Key Metric:** `orders_created` (Counter on HTTP 201).
  * **Today (Unpatched):** `orders_created > 1` (Bug reproduced).
  * **Phase 02 (Fixed):** `orders_created === 1`.

---

### 2. Double-Payment Vulnerability (`scenarios/double-payment.js`)
* **Purpose:** Proves that `payments/src/routes/new.ts` allows duplicate charges when parallel payment requests hit the same order.
* **Execution:**
  ```powershell
  k6 run scenarios/double-payment.js
  ```
* **Key Metric:** `payments_created` (Counter on HTTP 201).
  * **Today (Unpatched):** `payments_created > 1` (Multiple Stripe charges for 1 order).
  * **Phase 02 (Fixed):** `payments_created === 1`.

---

### 3. Browse Load Baseline (`scenarios/browse-load.js`)
* **Purpose:** Measures baseline read latency on `GET /api/tickets` without caching.
* **Execution:**
  ```powershell
  k6 run scenarios/browse-load.js
  ```
* **Key Metrics:** `http_req_duration` (p50, p90, p95, p99), requests/sec, error rate.
* **Comparison:** Compared against the Redis cache implementation in Phase 07.

---

### 4. End-to-End Purchase Flow (`scenarios/purchase-flow.js`)
* **Purpose:** Simulates full user lifecycle: Signup → List Ticket → Reserve Order → Pay.
* **Execution:**
  ```powershell
  k6 run scenarios/purchase-flow.js
  ```
* **Key Metrics:** Latency per step, completed vs failed flows, throughput.

---

---

## Step-by-Step Guide: How to Run and Verify Results

Here is the exact step-by-step workflow to run any test, read the metrics, and verify data in MongoDB.

### Step 1: Open PowerShell and Navigate to `load-tests`
```powershell
cd "d:\Node JS\Micro Services With NodeJS Course\ticketing\load-tests"
```

### Step 2: Run a Test Scenario
For example, to test the double-payment vulnerability:
```powershell
k6 run scenarios/double-payment.js
```
*(Or for read load: `k6 run scenarios/browse-load.js`)*

---

### Step 3: How to Read the k6 Terminal Output
When the test completes, k6 prints a summary table. Here is what each section means:

```text
  █ TOTAL RESULTS 

    checks_total.......: 12      
    checks_succeeded...: 100.00% 12 out of 12     <-- Did our assertions pass?

    CUSTOM
    payments_created...: 10                       <-- KEY BUG INDICATOR: 10 charges succeeded!

    HTTP
    http_req_duration..: avg=857ms  p(90)=1.39s  p(95)=1.44s   <-- Response times!
    http_req_failed....: 0.00% 0 out of 14        <-- Error rate (5xx / 4xx)
    http_reqs..........: 14     5.49/s            <-- Total HTTP calls and throughput (RPS)
```

* **`payments_created: 10`**: Confirms that the API returned `201 Created` for all 10 parallel payment requests on one order.
* **`http_req_duration` $\rightarrow$ `p(95)`**: The 95th percentile latency (95% of requests completed faster than this time).
* **`http_req_failed`**: Percentage of requests that returned HTTP errors.

---

### Step 4: Verify the Database (Automated)
Run the cross-database consistency checker:
```powershell
powershell -ExecutionPolicy Bypass -File checks/consistency.ps1
```

**What to look for in the output:**
* **Under `[2/3] Checking Payments Database...`**:
  ```text
  [BUG DETECTED] Multiple payments found for the SAME order!
  Duplicate payments: [{"_id":"6ac9ec7d2b5c79dd8e3091fa","count":10}]
  ```
  This proves MongoDB physically saved 10 distinct payment records for that single order ID.

* **Under `[3/3] Cross-Service Event Sync Check...`**:
  ```text
  [MISMATCH DETECTED] Completed orders (294) != Recorded payments (303)
  ```
  Shows desynchronization across microservice boundaries.

---

### Step 5: Manual Verification via `mongosh` (Optional Deep Dive)
If you want to manually inspect the raw database documents inside the pods:

1. **Find the payment pod name:**
   ```powershell
   kubectl get pods -l app=payments-mongo
   ```
2. **Execute a query directly inside MongoDB:**
   ```powershell
   $pod = (kubectl get pod -l app=payments-mongo -o jsonpath='{.items[0].metadata.name}')
   kubectl exec $pod -- mongosh payments --eval "db.payments.find().pretty()"
   ```
   You will see multiple payment documents with different `_id` values but sharing the exact same `orderId`!

3. **Check Service Logs for Errors or Crashes:**
   ```powershell
   kubectl logs -l app=orders --tail=50
   kubectl logs -l app=payments --tail=50
   ```

---

## k6 Quick Reference for Beginners

* **Lifecycle:**
  * `init`: imports & options definition (runs per VU parse).
  * `setup()`: runs **once** at the start to seed data/register users; returned object is passed to `default(data)`.
  * `default(data)`: the virtual user loop executed concurrently.
  * `teardown(data)`: runs **once** at the end for cleanup.
* **`http.batch(requests)`:** dispatches an array of requests in parallel over separate TCP connections simultaneously (crucial for reproducing race conditions).
* **`check(res, { ... })`:** assertions that record pass/fail rates without halting test execution.
* **`stages: [{ duration, target }]`:** smoothly ramps Virtual Users (VUs) up or down over time.
* **`thresholds: { 'p(95)<500': ... }`:** defines SLA pass/fail quality gates (fails with exit code 99 if violated).
* **Context variables:** `__VU` is the virtual user ID (`1..N`), `__ITER` is the iteration number (`0..M`).
