# Production Incident Triage & Troubleshooting Playbook (Observability in Action)

> **Purpose:**  
> When an alert fires at 2 AM or a customer reports an issue, you do not want to guess or randomly click around.  
> This playbook provides a **systematic, scenario-by-scenario triage guide**: for every common microservice failure, it tells you **which tool to open first**, **which exact metric/trace/log to inspect**, **how to pinpoint the root cause**, and **how to resolve it**.

---

## 1. The Core Triage Triangle: How the Tools Work Together

```text
                     ┌──────────────────────────────┐
                     │ 1. METRICS (Grafana/PromQL)  │
                     │  "WHEN & WHERE is it bad?"   │
                     └──────────────┬───────────────┘
                                    │ Alerts or anomaly detected
                                    ▼
                     ┌──────────────────────────────┐
                     │  2. TRACES (Jaeger UI)       │
                     │  "WHICH HOP & SPAN failed?"  │
                     └──────────────┬───────────────┘
                                    │ Isolated failing trace_id
                                    ▼
                     ┌──────────────────────────────┐
                     │ 3. LOGS (Pino / kubectl)     │
                     │  "WHAT is the exact error?"  │
                     └──────────────────────────────┘
```

---

## 2. "Which Tool Do I Open First?" Quick Reference Matrix

| Symptom / Alert | 1st Stop (Where to look) | What to Look For | 2nd Stop (Drill-Down) |
| :--- | :--- | :--- | :--- |
| **API is Slow / Latency Spike** | **Grafana:** Service Overview (RED) | p95/p99 Latency Histogram by route | **Jaeger:** Filter by `minDuration` to find slow DB or HTTP span |
| **5xx Internal Server Errors** | **Grafana:** Error Rate panel | `ticketing_http_requests_total{status_code=~"5.."}` | **Jaeger:** Search `error=true` ➔ **Logs:** Query `trace_id` |
| **"I paid, but order isn't completed"** | **Grafana:** Pipeline & Kafka Lag | `ticketing_outbox_pending_events` & Consumer Lag | **Jaeger:** Trace `POST /api/payments` to see if `orders` consumed |
| **Stripe is Down or Failing** | **Grafana:** Circuit Breaker panel | `ticketing_circuit_breaker_state` (= 2 Open) | **Logs:** `kubectl logs deploy/payments-depl` for fallback errors |
| **Kafka Messages Piling Up** | **Grafana:** Kafka Consumer Lag | `kafka_consumergroup_lag` growing | **Logs:** Consumer pod logs for deadlocks, retries, or slow queries |
| **Outbox Not Draining** | **Grafana:** Outbox Pending Gauge | `ticketing_outbox_pending_events > 50` | **MongoDB:** Check `leases` collection & Kafka broker health |
| **Order Timers Not Expiring** | **Grafana:** Business Metrics | `ticketing_orders_swept_total` spiking | **Redis / Expiration:** Bull queue worker logs |
| **Pod Crashing / Restarting** | **Kubernetes:** `kubectl get pods` | `STATUS: CrashLoopBackOff` or `OOMKilled` | **Kubernetes:** `kubectl describe pod <name>` for exit code 137 |

---

## 3. Step-by-Step Scenario Triage Guides

---

### Scenario 1: API Latency Spike (p99 > 3 Seconds)
**User Symptom:** *"Creating an order or browsing tickets is painfully slow."*

#### Step 1: Open Grafana (`http://localhost:3001`)
* Navigate to: **Dashboards ➔ Service Overview (RED)**.
* Check the **Request Duration (p95 / p99)** panel.
* Identify the offending route: e.g., `POST /api/orders` or `GET /api/tickets`.
* Check if all routes are slow (indicating node/cluster CPU exhaustion) or just one route (indicating a code or database lock issue).

#### Step 2: Open Jaeger UI (`http://localhost:16686`)
* Select **Service**: `orders` (or the slow service).
* Set **Min Duration**: `2s` (to filter out fast requests).
* Click **Find Traces**.
* Click into the slowest trace to open the **Waterfall View**:
  ```text
  [orders] POST /api/orders ---------------------------------------- [3200ms]
    ├── [orders] Mongoose: Ticket.findById ------------- [12ms]
    ├── [orders] Mongoose: Order.save ------------------ [15ms]
    └── [orders] Mongoose: transaction.commit ---------- [3150ms]  <-- BOTTLENECK!
  ```
* **Diagnosis:** If `transaction.commit` took 3150ms, MongoDB replica set write concern (`w: 'majority'`) or lock contention is causing delays. If an outbound HTTP call to an external service took 3000ms, that external API is stalling.

#### Step 3: Open Logs
* Copy the `trace_id` from the top of the Jaeger trace (e.g. `d8c804f75ce5bb9aa245f64c5e7aad41`).
* Filter logs:
  ```bash
  kubectl logs deploy/orders-depl | grep "d8c804f75ce5bb9aa245f64c5e7aad41"
  ```
* Look at the `responseTime` and internal debug messages.

#### Step 4: The Immediate Fix & Resolution
* **If a Database Query is slow:**
  - Check missing indexes on queried fields: `db.tickets.createIndex({ userId: 1 })`.
  - Add projection to return only needed fields (`Ticket.find().select('title price')`).
* **If MongoDB Transaction commit is slow:**
  - Minimize the transaction scope: perform third-party HTTP calls *outside* the `session.withTransaction()` block so DB row locks are held for milliseconds rather than seconds.
* **If External API (Stripe) is slow:**
  - Wrap the call with timeout protection (e.g., 3s timeout) and an Opossum circuit breaker so slow calls fail fast rather than hanging the Node.js event loop.

---

### Scenario 2: Sudden Spike in 500 Internal Server Errors
**Alert:** `HighErrorRate: tickets 5xx errors > 5% for 2m`.

#### Step 1: Open Grafana (`http://localhost:3001`)
* Navigate to: **Service Overview (RED)** ➔ **HTTP Request Rate & Errors**.
* Observe the error breakdown: Is it `400` (bad client payload), `401` (expired token), or `500` (unhandled server crash)?
* Identify the route: e.g., `POST /api/tickets` is throwing `500`.

#### Step 2: Open Jaeger UI (`http://localhost:16686`)
* Select **Service**: `tickets`.
* Check the **Tags** input and enter: `error=true`.
* Click **Find Traces**.
* Click the trace. Jaeger highlights the failing span in **RED**:
  ```text
  [tickets] POST /api/tickets [500 Internal Server Error]
    └── [tickets] request handler - /api/tickets [ERROR]
          ├── tags: error = true
          └── error.message = "Transaction numbers are only allowed on a replica set member or mongos"
  ```
* **Diagnosis:** The exact error tag on the span immediately reveals why the request crashed without needing to browse servers!

#### Step 3: Inspect Logs for Full Stack Trace
```bash
kubectl logs deploy/tickets-depl | grep -E '"level":50|"error"'
```
* Read the exact file name and line number in the stack trace.

#### Step 4: The Immediate Fix & Resolution
* **If Replica Set Error:** Run single-node initiation: `kubectl exec -it tickets-mongo-0 -- mongosh --eval "rs.initiate()"`.
* **If Bad Code / Null Pointer Bug:**
  - Immediate Mitigation: Roll back deployment to previous stable revision:
    ```bash
    kubectl rollout undo deploy/tickets-depl
    ```
  - Permanent Fix: Add defensive null check, patch code, and push new version.

---

### Scenario 3: The "Ghost" Order ("I paid, but my order is still pending!")
**Customer Complaint:** *"My credit card was charged $99, but my order says 'Created' instead of 'Complete'."*

#### Step 1: Check Grafana (`http://localhost:3001`)
* Open: **Event Pipeline & Kafka Lag** Dashboard.
* Look at two panels:
  1. **Transactional Outbox Backlog (`ticketing_outbox_pending_events`):**
     - If `payments` outbox pending is `> 0` and growing: The payment event was saved in MongoDB, but the **`OutboxRelay` background worker is stuck or failing to publish to Kafka**.
  2. **Kafka Consumer Group Lag (`kafka_consumergroup_lag`):**
     - Look at `orders-group` on topic `payment-events`.
     - If lag is `> 0`: The event was successfully published to Kafka, but the **`orders` consumer is slow, crashing, or deadlocked**.

#### Step 2: Open Jaeger UI (`http://localhost:16686`)
* Search by **Service**: `payments`, **Operation**: `POST /api/payments`.
* Open the trace waterfall:
  - Did the payment request succeed?
  - Does the waterfall show `publish: payment-events`?
  - Does it show `consume: payment:created` inside `orders`?
  - If `consume: payment:created` shows **red**, click it to see if `Order.findById` failed or version concurrency rejected the update!

#### Step 3: Check Dead Letter Queue (DLQ)
If an event fails processing 3 times, `EventConsumer` routes it to the DLQ:
```bash
# Check if consumer logged DLQ routing
kubectl logs deploy/orders-depl | grep "DLQ"
```

#### Step 4: The Immediate Fix & Resolution
* **If Message in DLQ:**
  - Inspect DLQ topic messages using `kafka-console-consumer` to identify the poisoned payload.
  - Fix the consumer logic bug or missing database record.
  - Run the DLQ replay tool to reprocess the failed message safely.
* **If Outbox is Stuck:**
  - Restart the payments deployment to release stale leases:
    ```bash
    kubectl rollout restart deploy/payments-depl
    ```
* **If Order Version Concurrency Conflict:**
  - Verify that the consumer uses OCC (Optimistic Concurrency Control) retry loops to re-fetch the latest order version before marking complete.

---

### Scenario 4: Downstream Third-Party Outage (Stripe API Down)
**Symptom:** *"Payment checkout is failing or timing out for all users."*

#### Step 1: Open Grafana (`http://localhost:3001`)
* Navigate to: **Event Pipeline & Kafka Lag** ➔ **Circuit Breaker State** panel.
* Metric: `ticketing_circuit_breaker_state{name="stripe_charge"}`:
  - `0 = Closed`: Healthy (traffic flows to Stripe).
  - `1 = Half-Open`: Testing recovery (limited trial requests sent).
  - `2 = Open`: **TRIPPED!** Stripe is down, and all calls fail fast in 1ms without hitting Stripe.

#### Step 2: Open Logs
```bash
kubectl logs deploy/payments-depl | grep -i "circuitbreaker"
```
* Output will show:
  ```text
  {"level":40,"msg":"[CircuitBreaker:stripe_charge] Breaker tripped to OPEN state. Failing fast."}
  ```

#### Step 3: The Immediate Fix & Resolution
* **Automatic Behavior:** The Opossum circuit breaker protects your servers by returning `503 Service Unavailable` in 1ms instead of tying up Node.js worker threads in 30s HTTP timeouts.
* **User-Facing Mitigation:** The frontend displays a graceful notice: *"Payment gateway is temporarily undergoing maintenance. Please retry in 2 minutes."*
* **Recovery:** When Stripe recovers, the breaker automatically shifts to `1 (Half-Open)`, allows a single probe request through, and resets to `0 (Closed)` upon success.

---

### Scenario 5: Outbox Relay Stalled (Pending Events Accumulating)
**Alert:** `HighOutboxLag: Outbox events pending > 50 for 2m`.

#### Step 1: Check Grafana (`http://localhost:3001`)
* Observe which service has high pending events:
  - `ticketing_outbox_pending_events{service="tickets"}` vs `{service="orders"}`.

#### Step 2: Check Outbox Poller Leases in MongoDB
In Phase 04, we implemented distributed leasing so only one pod relays events:
* Connect to MongoDB:
  ```bash
  kubectl exec -it orders-mongo-0 -- mongosh orders
  ```
* Inspect lease collection:
  ```javascript
  db.leases.find()
  ```
* If `leasedUntil` is in the distant future or the lease holder pod crashed, check if the lease heartbeat is working.

#### Step 3: Check Kafka Connectivity
* Verify the outbox relay can talk to Kafka:
  ```bash
  kubectl logs deploy/orders-depl | grep -i "outbox"
  ```
* Look for `KafkaJSConnectionError` or `LeaderNotAvailable`.

#### Step 4: The Immediate Fix & Resolution
* **If Stale Lease Lock:** Force clear the expired lease document in MongoDB so another replica can immediately acquire the outbox poller role:
  ```javascript
  db.leases.deleteMany({ name: "orders-outbox" })
  ```
* **If Kafka Broker Disconnected:**
  - Check broker pod status: `kubectl get pods -l app=kafka`.
  - Restart the outbox service: `kubectl rollout restart deploy/orders-depl`.

---

### Scenario 6: Expired Orders Stuck (Background Sweeper Triage)
**Symptom:** *"Tickets are reserved but user never paid, and the ticket was never released back to the market."*

#### Step 1: Check Grafana (`http://localhost:3001`)
* Navigate to: **Business Metrics** ➔ **Orders Swept by Background Sweeper** (`ticketing_orders_swept_total`).
* Under normal circumstances, orders expire via **Bull/Redis fast path** in `expiration` service.
* If `ticketing_orders_swept_total` is spiking:
  - The Redis timer fast-path is broken, and the background DB sweeper (`ExpireOrdersSweeper`) is having to rescue expired orders!

#### Step 2: Inspect Expiration & Redis Pods
```bash
# Check Redis pod
kubectl get pods -l app=expiration-redis
kubectl logs deploy/expiration-depl --tail 50
```
* Look for Redis connection drops or Bull queue stalls.

#### Step 3: The Immediate Fix & Resolution
* **Short-Term Safety:** The background sweeper is already safely cancelling stale orders in MongoDB, so tickets will not remain permanently locked.
* **Root Cause Fix:**
  - Restart the Redis instance or increase memory: `kubectl rollout restart statefulset/expiration-redis`.
  - Restart the expiration worker: `kubectl rollout restart deploy/expiration-depl`.

---

### Scenario 7: Pod CrashLoopBackOff or Out of Memory (OOMKilled)
**Symptom:** `kubectl get pods` shows `CrashLoopBackOff` or `Error`.

#### Step 1: Inspect Pod Status & Exit Code
```bash
kubectl get pods
kubectl describe pod <pod-name>
```
* Look at the `Last State` block:
  - **Exit Code 137:** Pod was killed by the Linux Kernel Out-Of-Memory killer (`OOMKilled`). The pod exceeded its memory limit in deployment YAML.
  - **Exit Code 1:** Unhandled JavaScript exception on startup.
  - **Exit Code 0:** Node process finished cleanly (usually means an async `await` was omitted and process exited).

#### Step 2: Read Previous Pod Logs
If the pod crashed and restarted, running `kubectl logs <pod>` only shows the new pod's startup!  
To see the logs from the crash:
```bash
kubectl logs <pod-name> --previous
```

#### Step 3: The Immediate Fix & Resolution
* **If Exit Code 137 (OOMKilled):**
  - Increase container memory limits in the deployment YAML:
    ```yaml
    resources:
      limits:
        memory: "512Mi"  # Bump to 1Gi if Node heap exhausted
    ```
  - Apply the manifest: `kubectl apply -f infra/k8s/<service>-depl.yaml`.
* **If Exit Code 1 (Missing Env / Secret):**
  - Verify secrets and configmaps exist:
    ```bash
    kubectl get secrets jwt-secret stripe-secret
    ```
  - Check missing environment variables in deployment manifest.

---

## 4. Useful PromQL Queries for Fast Triage

Copy and paste these queries into **Prometheus UI (`http://localhost:9090`)**:

| Triage Goal | PromQL Query |
| :--- | :--- |
| **Top 5 Slowest Routes (p99)** | `topk(5, histogram_quantile(0.99, sum(rate(ticketing_http_request_duration_seconds_bucket[5m])) by (le, route, service)))` |
| **Error Percentage per Service** | `sum(rate(ticketing_http_requests_total{status_code=~"5.."}[5m])) by (service) / sum(rate(ticketing_http_requests_total[5m])) by (service) * 100` |
| **Total Outbox Backlog Across All Services** | `sum(ticketing_outbox_pending_events) by (service)` |
| **Highest Consumer Lag per Topic** | `topk(5, max(kafka_consumergroup_lag) by (consumergroup, topic))` |
| **Circuit Breakers Currently Open** | `ticketing_circuit_breaker_state == 2` |

---

## 5. Summary: The Golden Rules of Production Triage

1. **Never guess:** Start with Grafana to find *which service* is hurting.
2. **Never search blindly through logs:** Use Jaeger to isolate the exact failing *`trace_id`*, then grep logs specifically for that ID.
3. **Remember the Outbox Bridge:** In an event-driven system, HTTP 200 does not mean the workflow finished. Always verify the Outbox Backlog and Kafka Consumer Lag!
