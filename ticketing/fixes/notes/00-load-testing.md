# Interview Notes: 00 — Baseline & Load Testing

> **Topic:** Why load testing comes before fixing, how to reproduce distributed concurrency bugs, and interpreting tail latency.

---

## 1. The Problem
In distributed systems, unit tests with Jest and Supertest only verify sequential logic in isolation. They are completely blind to timing bugs, check-then-act race conditions (TOCTOU), and network retries.
In our ticketing platform:
1. When 10 concurrent payments hit `/api/payments` for the same order, all 10 charge the user's card because there is no idempotency key or completed-state check.
2. When concurrent event listeners fail due to Optimistic Concurrency Control (`VersionError`), unhandled promise rejections kill the Node.js process while Kubernetes continues to route user traffic to the dead pod.

---

## 2. Why It Matters (Business & Financial Impact)
* **Financial Liability & Chargebacks:** Charging a customer 10 times for a $99 ticket results in customer complaints, bank dispute fees ($15-$25 per chargeback), and potential merchant account termination by payment processors.
* **Reputation Loss:** In flash sales, overselling tickets means disappointing fans and dealing with costly public relations fallout.
* **Silent Outages:** Pods that crash internally while Kubernetes reports them as `Running` result in mysterious 502 Bad Gateway errors for innocent users.

---

## 3. The Solution
Before modifying any source code or Kubernetes configuration, we built a dedicated automated test suite using **k6** to deliberately trigger these edge cases under high concurrency, measuring:
* Double charges (`double-payment.js`)
* Read throughput and percentiles without caching (`browse-load.js`)
* End-to-end multi-step checkout latency (`purchase-flow.js`)
* Pod termination fault tolerance (`chaos-test.ps1`)
* Cross-service data consistency (`consistency.ps1`)

---

## 4. How We Built It

```text
 ┌────────────────────────────────────────────────────────────────────────┐
 │                              k6 Engine                                 │
 │                                                                        │
 │  [ double-payment.js ] ──► http.batch(10) ──► Payments Service        │
 │  [ browse-load.js ]    ──► 50 VUs (15k req) ──► Tickets Service        │
 │  [ purchase-flow.js ]  ──► 20 VUs          ──► Full User Journey       │
 └────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
 ┌────────────────────────────────────────────────────────────────────────┐
 │                      Kubernetes Cluster Validation                     │
 │                                                                        │
 │  consistency.ps1 ──► Queries MongoDB pods directly via mongosh        │
 │                       ↳ Flags duplicate payments & orders             │
 └────────────────────────────────────────────────────────────────────────┘
```

* **Files Created:**
  * `load-tests/lib/config.js` — Shared target configuration and TLS settings.
  * `load-tests/lib/auth.js` — User registration and auth session cookie management.
  * `load-tests/lib/tickets.js` — High-level API client for tickets, orders, and payments.
  * `load-tests/scenarios/double-payment.js` — Batch concurrency test proving duplicate charges.
  * `load-tests/scenarios/browse-load.js` — 50 VU read test measuring baseline latency.
  * `load-tests/scenarios/purchase-flow.js` — 4-stage end-to-end checkout pipeline.
  * `load-tests/scenarios/chaos-test.ps1` — Traffic generation with mid-stream pod deletion.
  * `load-tests/checks/consistency.ps1` — Cross-database integrity inspector.

---

## 5. k6 Architecture & Concepts Cheatsheet (From Scratch)

If you are new to **k6**, here is a simple breakdown of every k6 feature and pattern used in our codebase:

### A. The 4-Stage Test Lifecycle
Every k6 test executes in a strictly defined 4-stage lifecycle:

```text
 ┌───────────────┐
 │   1. INIT     │  Imports, declare metrics, configure options (runs once per VU init)
 └───────┬───────┘
         ▼
 ┌───────────────┐
 │   2. SETUP    │  Runs ONCE at the start. Seeds DB, registers users, creates tickets.
 └───────┬───────┘  ↳ Returns a `data` object passed directly to all VUs!
         ▼
 ┌───────────────┐
 │  3. DEFAULT   │  The VU loop function. Runs concurrently across all Virtual Users!
 └───────┬───────┘  (e.g., thousands of times during a load test)
         ▼
 ┌───────────────┐
 │  4. TEARDOWN  │  Runs ONCE at the very end for cleanup and logging.
 └───────────────┘
```

* **Why `setup()` is critical in our code:** Instead of 100 users trying to register during the flash sale, `setup()` pre-registers all 100 buyers, collects their auth cookies, creates 1 ticket, and passes `{ ticketId, buyers }` directly to the `default` function.

---

### B. Virtual Users (VUs) vs Iterations
* **VU (Virtual User):** A lightweight thread (Go goroutine) simulating an individual human user.
* **Iteration:** One single execution of the `default` function by a VU.
* **Built-in Context Variables:**
  * `__VU`: The integer ID of the current virtual user (`1, 2, 3 ... N`).
  * `__ITER`: The iteration number for that specific VU (`0, 1, 2 ...`).
  * *How we used it:* `data.buyers[__VU - 1]` allows each VU to uniquely grab its own distinct buyer cookie without collisions!

---

### C. `http.batch()` vs Sequential Requests (The Race Condition Weapon)
* **Sequential `http.post()`:**
  If you write a `for` loop calling `http.post()`, each request waits for the previous one to complete before sending the next. Sequential requests rarely collide!
* **`http.batch(requests)`:**
  Takes an array of request objects and dispatches them **in parallel across separate TCP sockets at the exact same microsecond**:
  ```javascript
  const requests = [
      { method: 'POST', url: '/api/payments', body: payload, params: { headers } },
      { method: 'POST', url: '/api/payments', body: payload, params: { headers } },
  ];
  const responses = http.batch(requests); // Fired in parallel!
  ```
  * *Why we used it:* This is how we successfully triggered the double-payment vulnerability (10 charges on 1 order)!

---

### D. Traffic Shaping with `stages`
Instead of instantly bombarding a server with 500 users (which might immediately crash it), `stages` gradually ramps traffic up and down:

```javascript
stages: [
    { duration: '15s', target: 20 },  // Ramp-up: 0 to 20 users over 15 seconds
    { duration: '30s', target: 50 },  // Plateau: maintain 50 users for 30 seconds
    { duration: '15s', target: 0 },   // Ramp-down: drain users back to 0
]
```

---

### E. Assertions with `check()` vs Jest `expect()`
In Jest, if an `expect()` fails, the test throws an error and halts execution.  
In k6, **`check()` does not stop the test**. It records a pass/fail tally so you can measure what percentage of requests succeeded under load:

```javascript
check(res, {
    'status is 201': (r) => r.status === 201,
});
```

---

### F. Metrics: Counters vs Trends
k6 provides custom metric types to track business indicators:
1. **`Counter`:** A cumulative tally that only increases.
   * `export const paymentsCreated = new Counter('payments_created');`
   * `paymentsCreated.add(1);`
2. **`Trend`:** Tracks statistical distributions (avg, min, med, max, p90, p95).
   * `export const payLatency = new Trend('step_pay_order_duration');`
   * `payLatency.add(Date.now() - startTime);`

---

### G. Thresholds (Automated Pass/Fail SLAs)
`thresholds` enforce Service Level Objectives (SLOs). If a threshold fails, k6 exits with code `99`:

```javascript
thresholds: {
    http_req_failed: ['rate<0.01'],    // Less than 1% of requests may fail
    http_req_duration: ['p(95)<1000'], // 95% of requests must respond in under 1 second
}
```

---

## 6. Trade-offs & Tooling Decisions

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Jest / Supertest** | Fast, familiar, runs in CI | Sequential only, cannot simulate concurrent socket collisions | Inadequate for distributed concurrency testing |
| **Apache JMeter** | Powerful, mature UI | Heavy Java memory footprint, complex XML scripts | Rejected (high resource overhead on local dev) |
| **Artillery** | Node.js based | High CPU consumption on Windows when spawning many VUs | Rejected |
| **k6 (Grafana)** | Go core (very fast), JS scripts, low CPU, built-in percentiles | Requires CLI install | **Selected** |

---

## 7. Numbers & Measured Proof

| Scenario | Measured Baseline (Today) | Target (After Phase 02 / 04 / 07) |
|---|---|---|
| 10 Batch Payments on 1 Order | **10 Charges Succeeded (100% bug reproduction)** | Exactly 1 succeeded, 9 rejected |
| Duplicate Payment Records in DB | **10 records for Order `6ac9ec7d...`** | Exactly 1 record |
| Read Latency (GET /tickets) | **p95 = 4.93ms (MongoDB direct)** | < 1ms (Redis Cache in Phase 07) |
| Read Throughput | **252 req/s** | > 1,500 req/s |
| In-flight Request Resilience | **502 Bad Gateway on pod crash** | 0 dropped requests (Graceful shutdown in Phase 01) |

---

## 8. Interview Q&A

### Q1: Why did you invest time in load testing before writing any fixes?
> **Answer:** *"Because claims without metrics are just assumptions. If I say 'I fixed race conditions and optimized the system', the first question from a Senior Engineer or SRE is: 'What was your failure rate before, and how did you verify the fix?' By establishing a baseline with k6, I proved the exact failure mode (10 charges on 1 order) and have an automated regression test to verify that the fix drops failure to zero."*

### Q2: Why did your unit tests pass if the payment double-charge bug existed?
> **Answer:** *"Jest and Supertest execute tests sequentially with `await`. The first request completes and updates the database before the second request is even created. In production, multiple requests arrive concurrently and interleave across async I/O boundaries. The gap between checking the order status and saving the payment allowed all 10 requests to pass validation before any payment record existed."*

### Q3: Why is average latency a misleading metric in distributed systems?
> **Answer:** *"Averages conceal catastrophic tail latencies. If 95 users receive responses in 20ms and 5 users take 5,000ms, the average is 269ms—which looks healthy on a dashboard. But 5% of users experienced a 5-second freeze. Furthermore, in microservices, tail latency multiplies across service hops: a 5% delay probability across 4 downstream services results in an 18.6% probability that an end-user experiences a delayed checkout. We always measure p95 and p99."*

### Q4: How did you verify that duplicate payments actually occurred in the database?
> **Answer:** *"In addition to verifying that all 10 HTTP requests returned HTTP 201 Created from the API, we wrote an automated script (`consistency.ps1`) that executes MongoDB aggregation queries directly inside the database pods via `kubectl exec`. It found `[{ _id: '...', count: 10 }]`, proving that the duplicate data was committed to persistent storage."*

### Q5: What happened when the orders pod was killed mid-traffic?
> **Answer:** *"Because the current service lacks Kubernetes `readinessProbes` and a graceful shutdown handler (`preStop` sleep and connection draining), in-flight requests were aborted immediately with 502 Bad Gateway responses, and pending events were delayed. This highlighted the urgent need for Phase 01's infrastructure foundation."*
