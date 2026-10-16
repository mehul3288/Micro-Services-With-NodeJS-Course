# Phase 06-C: Live Demo Runbook & Scenarios Guide (Observability in Action)

> **Purpose of this guide:**
> This document is a **step-by-step presentation runbook**.
> Whether presenting to an engineering manager, conducting a technical interview, or demonstrating the platform to your team, follow these concrete scenarios to showcase your distributed tracing, structured logging, Prometheus telemetry, and Grafana dashboards in real time.

---

## 0. Quick Prep: Accessing the Observability Stack

Before starting any demo scenario, open 3 terminal tabs and start port-forwarding:

```powershell
# Tab 1: Grafana Dashboards (Port 3001)
kubectl port-forward svc/grafana-srv 3001:3000

# Tab 2: Jaeger Tracing UI (Port 16686)
kubectl port-forward svc/jaeger-srv 16686:16686

# Tab 3: Prometheus Alert Manager & Targets (Port 9090)
kubectl port-forward svc/prometheus-srv 9090:9090
```

### Bookmark These URLs in Your Browser:
1. **Application UI:** `https://ticketing.dev`
2. **Grafana Dashboards:** `http://localhost:3001` *(Anonymous Admin access enabled — no login needed)*
3. **Jaeger Distributed Tracing:** `http://localhost:16686`
4. **Prometheus Targets & Alerts:** `http://localhost:9090`

---

## Scenario 1: The "Happy Path" Distributed Trace Across Kafka (Jaeger)

### The Concept to Demonstrate:
When an order is created, the request touches multiple microservices asynchronously:
`User HTTP POST` ➔ `orders` (Mongo Outbox) ➔ `OutboxRelay` ➔ `Kafka` ➔ `tickets` (locks seat) + `expiration` (starts 60s timer).
Standard OpenTelemetry drops trace context because the outbox background relay runs in a separate thread. **Show that our explicit W3C `traceparent` injection keeps the entire distributed timeline intact.**

### Steps to Reproduce:
1. Open **`https://ticketing.dev`** in your browser.
2. Sign in, create a new ticket (e.g. *"Coldplay Concert - $150"*), and click **Order**.
3. Now open **Jaeger UI** (`http://localhost:16686`):
   - Under **Service**, select **`orders`**.
   - Under **Operation**, select `POST /api/orders` (or leave as `all`).
   - Click **Find Traces**.
4. Click on the topmost trace that appears.

### What You Will See on Screen:
A multi-service waterfall diagram:
```text
▼ orders: POST /api/orders                                    [ 45ms ]
    ├─ mongoose: orders.insertOne
    ├─ mongoose: outboxevents.insertOne (stores traceparent)
    ▼ orders: outbox_relay dispatch                           [ +12ms ]
        └─ kafkajs: producer.send(order-events)
            ▼ tickets: event_consumer order:created           [ +18ms ]
            │   └─ mongoose: tickets.updateOne (reserve seat)
            ▼ expiration: event_consumer order:created        [ +19ms ]
                └─ bull: expirationQueue.add (60s timer)
```

### What to Explain:
> *"Notice how the trace does not stop when the HTTP response returns. Because we explicitly serialize the W3C `traceparent` header into the MongoDB `OutboxEvent` document and unpack it in `EventConsumer`, the asynchronous processing inside `tickets` and `expiration` is linked directly to the client's initial click."*

---

## Scenario 2: Trace-to-Log Correlation & Security Redaction (Pino)

### The Concept to Demonstrate:
Every production log line must be structured JSON, have sensitive authentication data redacted, and contain the exact `trace_id` that ties it back to Jaeger.

### Steps to Reproduce:
1. In your PowerShell terminal, fetch the latest logs from the `orders` pod:
   ```powershell
   kubectl logs -l app=orders --tail=15
   ```
2. Inspect any completed request line:
   ```json
   {
     "level": 30,
     "time": 1792160991355,
     "service": "orders",
     "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
     "span_id": "00f067aa0ba902b7",
     "req": {
       "method": "POST",
       "url": "/api/orders",
       "headers": {
         "cookie": "[REDACTED]",
         "authorization": "[REDACTED]"
       }
     },
     "msg": "request completed"
   }
   ```
3. Copy the `trace_id` value (e.g. `4bf92f3577b34da6a3ce929d0e0e4736`).
4. Switch to **Jaeger UI** (`http://localhost:16686`), paste that exact ID into the top-right search box: **"Lookup by Trace ID"**, and press Enter.

### What You Will See on Screen:
Jaeger immediately opens the exact waterfall trace corresponding to that log entry!

### What to Explain:
> *"In production, an on-call engineer searching an error log can immediately jump from a single log message directly to the visual trace waterfall in Jaeger using the correlation `trace_id`. Additionally, sensitive user cookies and JWTs are automatically stripped by Pino's redaction filter before writing to stdout."*

---

## Scenario 3: Real-Time Traffic Spikes & RED Metrics (Grafana)

### The Concept to Demonstrate:
The **RED Method** (Rate, Errors, Duration) gives a real-time health pulse of our services without exposing unbounded cardinality to the time-series database.

### Steps to Reproduce:
1. Open **Grafana** (`http://localhost:3001`).
2. Go to **Dashboards** ➔ **Service Overview (RED)**.
3. In PowerShell, generate a burst of 25 HTTP requests to simulate active traffic:
   ```powershell
   1..25 | ForEach-Object {
       Invoke-RestMethod -Uri "https://ticketing.dev/api/tickets" -Method Get -SkipCertificateCheck
   }
   ```
4. Observe the Grafana dashboard in real time.

### What You Will See on Screen:
- **HTTP Request Rate (req/s):** The `tickets` line spikes upwards showing instantaneous throughput.
- **HTTP P95 Request Duration:** The histogram quantile calculates the 95th percentile latency (e.g. ~12ms).
- **Route Normalization:** Notice that routes are normalized to `/api/tickets` and `/api/tickets/:id`. Dynamic MongoDB ObjectIDs do not create separate metrics, preventing cardinality explosion.

---

## Scenario 4: The Circuit Breaker Tripping Scenario (Resilience Telemetry)

### The Concept to Demonstrate:
When external providers (like Stripe) fail or timeout, the Opossum circuit breaker trips open to protect the service, immediately visible on Grafana and triggering Prometheus alerts.

### Steps to Reproduce:
1. Open **Grafana** (`http://localhost:3001`) ➔ **Service Overview (RED)**.
2. Note the panel: **Circuit Breaker State (0=Closed, 1=Half-Open, 2=Open)**. Currently, `stripe_charge` and `stripe_refund` show `0` (Green).
3. Open **Prometheus Alerts** (`http://localhost:9090/alerts`).
4. Locate the alert rule **`CircuitBreakerOpen`**. It will be in `0 active` (Green) state.
5. In `payments/src/services/stripe-client.ts`, simulate external provider degradation (e.g. setting timeout to 1ms or triggering consecutive timeouts).
6. Once the failure threshold (50%) is reached after 5 requests:
   - The circuit breaker trips open.
   - The Grafana gauge turns **Red** with value `2 (Open)`.
   - The Prometheus alert transitions to `PENDING` ➔ `FIRING`.

### What to Explain:
> *"The circuit breaker prevents cascading latency from overwhelming the payments pod when Stripe degrades. Instead of hanging for 30 seconds, subsequent requests fail fast in under 1ms with HTTP 503, and the Prometheus alert immediately notifies the operations team."*

---

## Scenario 5: Kafka Consumer Lag & Queue Drain (Pipeline Telemetry)

### The Concept to Demonstrate:
Consumer group lag is the single most vital health metric for event-driven architectures. If a downstream consumer dies or falls behind, lag accumulates and must be visible.

### Steps to Reproduce:
1. Open **Grafana** (`http://localhost:3001`) ➔ **Event Pipeline & Kafka Lag**.
2. Simulate a crash or downtime of the `tickets` worker by scaling it to 0 replicas:
   ```powershell
   kubectl scale deploy/tickets-depl --replicas=0
   ```
3. Generate order events that `tickets` is supposed to consume (e.g. create 5 orders in `ticketing.dev`).
4. In Grafana:
   - Look at the **Kafka Consumer Group Lag** panel.
   - The lag for consumer group `tickets-service` on topic `order-events` will climb: `1, 2, 3, 4, 5`.
   - The Prometheus alert **`HighKafkaLag`** begins tracking the backlog.
5. Now recover the service by scaling `tickets` back up:
   ```powershell
   kubectl scale deploy/tickets-depl --replicas=1
   ```
6. Watch the Grafana dashboard:
   - Within 5 seconds, the new `tickets` pod rejoins the consumer group.
   - The **Events Consumed Rate** spikes as it batches through the backlog.
   - **Consumer Group Lag drops back to 0.**

### What to Explain:
> *"By combining the Kafka Exporter with Grafana, we can monitor partition offsets in real time. We demonstrated that when tickets went offline, messages safely queued up in Kafka without data loss, and upon recovery, the consumer processed the backlog and restored lag to zero."*

---

## Scenario 6: The Automated Sweeper & Business Metrics

### The Concept to Demonstrate:
Observability is not just for infrastructure errors—it tracks real business KPIs and safety-net reconciliation loops.

### Steps to Reproduce:
1. Open **Grafana** (`http://localhost:3001`) ➔ **Business Metrics**.
2. Notice the panels:
   - **Orders Created Rate (orders/min)**
   - **Successful Payments Rate (payments/min)**
   - **Orders Swept by Background Job**
3. Create an order on `https://ticketing.dev` and do **not** pay for it.
4. Let the order expire (after 60 seconds).
5. When the `ExpireOrdersSweeper` safety net job executes:
   - It acquires the distributed lock from MongoDB (`acquireLease`).
   - It cancels the orphaned order and increments `ticketing_orders_swept_total`.
   - The **Orders Swept by Background Job** metric in Grafana registers the cancellation.

---

## Summary Cheat Sheet for Presentations

| Question You Might Be Asked | Key Architectural Answer |
| :--- | :--- |
| *"Why didn't you just use `console.log`?"* | `console.log` is unindexed and unstructured. Pino produces machine-readable JSON, automatically correlates every line with OpenTelemetry `trace_id`, and redacts authorization cookies. |
| *"How does distributed tracing work through Kafka?"* | We inject the W3C `traceparent` header into the MongoDB `OutboxEvent` document at write time, send it via Kafka message headers, and extract it in `EventConsumer` so the trace never breaks across async boundaries. |
| *"How do you prevent metric cardinality explosions?"* | `getRoutePattern` normalizes route paths using Express metadata (`/api/tickets/:id`), ensuring variable IDs (like MongoDB ObjectIDs) never turn into unique metric labels. |
| *"What happens if Grafana or Prometheus restarts?"* | Dashboards, alert rules, and datasources are declared as Kubernetes ConfigMaps (`infra/k8s/observability/`) and automatically provisioned at container startup (GitOps). |
