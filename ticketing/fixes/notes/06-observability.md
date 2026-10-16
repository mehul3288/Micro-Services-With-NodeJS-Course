# Phase 06 Notes — Observability (Logs, Distributed Tracing & Metrics)

## 1. Architectural Motivation: Eliminating System Blindspots

In a distributed event-driven microservices system, troubleshooting issues without comprehensive telemetry is untenable:
* **Asynchronous Cascades:** A single user checkout triggers multiple asynchronous workflows across Kafka, MongoDB outboxes, and external APIs (Stripe).
* **The "Outbox Tracing Disconnect":** Standard OpenTelemetry HTTP/KafkaJS instrumentation assumes synchronous publishing. When the Transactional Outbox pattern stores events in MongoDB and dispatches them via a background poller, trace propagation breaks unless explicitly captured and restored.
* **Metric Cardinality Explosions:** Naive Prometheus instrumentation using raw URLs with dynamic entity IDs (`/api/tickets/65f9a...`) causes memory exhaustion in Prometheus TSDB.

---

## 2. Key Architectural Decisions & Solutions

### 2.1 W3C Context Propagation & Active Spans Across the Transactional Outbox
* **Capture:** During `OutboxPublisher.publish()`, OpenTelemetry's active context is serialized into a W3C `traceparent` string via `propagation.inject(context.active(), headers)`.
* **Storage:** The `headers` dictionary is persisted in MongoDB as part of the `OutboxEvent` schema.
* **Transmission:** `OutboxRelay` extracts the context and starts an active `PRODUCER` span (`tracer.startActiveSpan("publish: " + event.topic, ...)`) while sending to Kafka with clean headers.
* **Restoration:** In `EventConsumer`, headers are extracted and an active `CONSUMER` span (`tracer.startActiveSpan("consume: " + eventType, ...)`) is started.
* **Impact:** Downstream database operations (Mongoose `save` / `findOne`) detect the active span and nest directly under the consumer span. Jaeger visualizes the entire end-to-end request timeline from the initial HTTP call through MongoDB outbox dispatch to downstream Kafka event consumers and DB replicas in a single continuous 19-span waterfall trace.

### 2.2 Structured Logging with Pino
* Standard JSON schema: `{"level": 30, "time": "...", "service": "orders", "trace_id": "...", "span_id": "...", "msg": "..."}`.
* Automatic trace correlation: Logs automatically inherit `trace_id` and `span_id` from the active OpenTelemetry span.
* Redaction engine: Automatically strips `cookie`, `authorization`, `set-cookie`, `password`, and `token` fields.
* Kubelet Probe Suppression: `autoLogging.ignore` filters `url.startsWith("/healthz") || url.startsWith("/metrics")` to eliminate probe spam every 5s.

### 2.3 Prometheus RED & Pipeline Metrics
* **RED Method:** `ticketing_http_requests_total` (Rate & Errors) and `ticketing_http_request_duration_seconds` (Duration).
* **Route Pattern Normalization:** `getRoutePattern` extracts Express route templates (`/api/tickets/:id`), preventing unbounded cardinality.
* **Pipeline Metrics:**
  * `ticketing_outbox_pending_events` (Gauge)
  * `ticketing_outbox_publish_lag_seconds` (Histogram)
  * `ticketing_circuit_breaker_state` (Gauge: 0=closed, 1=half-open, 2=open)
  * `ticketing_events_published_total` / `ticketing_events_consumed_total` (Counters)
  * `ticketing_orders_swept_total` (Counter)

### 2.4 Kubernetes Observability Stack
* **Jaeger:** All-in-one tracing collector with OTLP HTTP (4318) at `/v1/traces` and gRPC (4317) endpoints.
* **Prometheus:** Configured with Kubernetes pod discovery to scrape any pod annotated with `prometheus.io/scrape: "true"`. Target labels mapped via relabel rule (`__meta_kubernetes_pod_label_app` -> `service`). Built-in alert rules for high error rate, outbox lag, circuit breaker trip, and Kafka lag.
* **Kafka Exporter:** Evaluates consumer lag across consumer groups and topic partitions.
* **Grafana:** Pre-provisioned with Prometheus datasource and 3 dashboards (Service Overview RED, Event Pipeline & Kafka Lag, Business Metrics).

---

## 3. Production Deployment Notes

1. **The Rule of Line 1:** Always ensure `import "./tracing";` is on line 1 of every service entry point before any other import.
2. **Prometheus Port-Forwarding:**
   ```bash
   kubectl port-forward svc/grafana-srv 3001:3000
   kubectl port-forward svc/jaeger-srv 16686:16686
   kubectl port-forward svc/prometheus-srv 9090:9090
   ```
3. **Common Package Version:** `@mehul-mrtickets/common@3.3.1`.
4. **Live Presentation & Demos:** See [06-c — Observability Live Demo Runbook & Scenarios Guide](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/fixes/lessons/06-c-observability-demo-guide.md) for 6 step-by-step presentation scenarios with exact commands and talking points.

---

## 4. Industry Reality: Daily Coding vs. One-Time Setup

### 4.1 Who writes this code in tech companies?
* **90% One-Time Setup (Platform / Core Infrastructure / Staff Engineers):**
  - In mid-to-large engineering organizations, this setup is created once by a **Platform Engineering**, **Foundation / DevEx**, or **Senior/Staff Backend Engineer**.
  - It is packaged into a shared internal SDK (e.g., our `@mehul-mrtickets/common`) or a microservice chassis / boilerplate generator (`create-service`).
* **Day-to-Day Feature Engineers:**
  - Product engineers building new endpoints do **not** re-instrument OpenTelemetry or redefine Prometheus histograms every day.
  - They simply consume the conventions:
    ```typescript
    // Feature engineer workflow:
    logger.info({ orderId: order.id }, "Order successfully placed");
    ```
  - All the heavy lifting—injecting `trace_id`, computing p99 latency histograms, exporting to Jaeger, scrubbing sensitive headers, and propagating Kafka headers—runs transparently in the background.
* **When does a backend engineer need to write or fix this?**
  - When designing **custom distributed workflows** (e.g. Transactional Outbox, async saga orchestrations, custom messaging gateways). If an engineer doesn't understand context propagation, distributed tracing silently severs and breaks.

---

## 5. What Do Interviewers Actually Expect from You?

### 5.1 Do interviewers expect you to write all this code from memory?
**NO. Absolutely not.**  
No interviewer will ask you to write the exact syntax of `tracer.startActiveSpan()` or memorize Prometheus histogram bucket arrays on a whiteboard.

### 5.2 What DO interviewers test you on?
Interviewers (especially for **Mid-Level, Senior, and Staff Backend / System Design** roles) ask about observability to evaluate whether you have **real distributed systems experience** versus toy/localhost projects. They look for:
1. **Architectural Mental Model:** Can you articulate the 3 pillars and how `trace_id` binds them together?
2. **Production Gotchas:** Do you know how async boundaries break tracing, and why high-cardinality crashes Prometheus?
3. **Debugging Methodology:** Can you walk through a real incident from an alert, to a trace, to a log line, to the exact line of code?

---

## 6. Scenario-Based Interview Questions & Model Answers

### Scenario 1: The Broken Asynchronous Trace
> **Question:** *"We use OpenTelemetry auto-instrumentation and Kafka. When we migrated from direct Kafka publishing to the Transactional Outbox pattern, our Jaeger traces broke into disconnected pieces. Why did that happen, and how do you architect the fix?"*

* **Model Answer:**
  > "Standard OpenTelemetry KafkaJS auto-instrumentation relies on synchronous execution where `producer.send()` is called while the HTTP request context is active in `AsyncLocalStorage`.  
  > In the Transactional Outbox pattern, the HTTP handler only writes an `OutboxEvent` document to MongoDB and finishes. 200ms later, a background `OutboxRelay` poller runs in an independent timer loop. The original request context is gone, so the poller either creates a new trace or publishes with empty headers.  
  > We fix this in three steps:
  > 1. **Inject:** In `OutboxPublisher.publish()`, we call `propagation.inject(context.active(), headers)` to serialize the W3C `traceparent` directly into the MongoDB document.
  > 2. **Relay Active Span:** In `OutboxRelay`, we extract the context and wrap `producer.send()` in `tracer.startActiveSpan('publish: ' + topic, { kind: PRODUCER }, extractedContext, ...)`.
  > 3. **Consume Active Span:** In `EventConsumer`, we extract the headers from Kafka and start an active `CONSUMER` span with `tracer.startActiveSpan('consume: ' + type, ...)`.  
  > This ensures that all downstream Mongoose database queries inside the consumer automatically nest as children in the exact same waterfall trace."

---

### Scenario 2: The Prometheus TSDB Out-of-Memory (OOM) Crash
> **Question:** *"After a major marketing push, your Prometheus server crashed with an Out-of-Memory (OOM) error. Your team finds that HTTP metrics were the culprit. What happened and how do you prevent it?"*

* **Model Answer:**
  > "This is the classic **High-Cardinality Trap**. In Prometheus, every unique combination of key-value label pairs generates a brand new time-series stored in memory.  
  > If an engineer instruments an HTTP metric using the raw request URL (`/api/tickets/65f9a12b...`) or includes dynamic parameters like `userId` or `orderId` in metric labels, 100,000 unique requests create 100,000 separate time-series in RAM.  
  > **The Prevention:** We implement route pattern normalization (`getRoutePattern`) using Express route metadata (`req.route.path`). This normalizes all dynamic IDs into parameterized templates (e.g. `/api/tickets/:id`). Bounded cardinality ensures the total number of time-series equals the static number of routes, regardless of traffic volume."

---

### Scenario 3: The Intermittent 500 Error Drill-Down
> **Question:** *"A customer complains that their payment failed with an internal error once, but the system is currently reporting 99.9% uptime and all services are green. How do you triage this using your observability stack?"*

* **Model Answer:**
  > "I follow the trace-to-log drill-down:
  > 1. In our structured logs or user session telemetry, I locate the failed request or customer ID, which provides the unique **`trace_id`**.
  > 2. I open Jaeger and paste the `trace_id`. The waterfall view instantly exposes every hop: the initial HTTP POST to `payments`, the MongoDB write, the outbound call to Stripe, and the Kafka event dispatch.
  > 3. Any span that failed will be highlighted in **red** with error tags.
  > 4. In our log aggregator, I query all logs filtered by `trace_id == '<id>'`. Because Pino automatically injects `trace_id` and `span_id` into every log line via OpenTelemetry hooks, I can read the exact stack trace and error message from that specific microservice without wading through unrelated logs."

---

### Scenario 4: The Silent Queue Stall (Consumer Lag vs Outbox Backlog)
> **Question:** *"Orders are being created, payments are succeeding, but users report their tickets are not being delivered. The HTTP APIs return 200 OK. Where do you look first?"*

* **Model Answer:**
  > "In an event-driven system, HTTP status 200 only means the command was accepted and saved to the outbox—not that the downstream saga has completed. I check two critical pipeline metrics:
  > 1. **`ticketing_outbox_pending_events` (Gauge):** If this metric is high and climbing, the bottleneck is in the publisher service: either MongoDB transactions are lagging, the outbox lease is locked, or Kafka brokers are unreachable.
  > 2. **Kafka Consumer Lag (`kafka_consumergroup_lag` via Kafka Exporter):** If the outbox is draining (low pending events), but Kafka consumer lag for the `tickets` or `orders` consumer group is growing, the consumer service is either crashed, deadlocked on database locks, or failing to acknowledge offsets.  
  > By comparing outbox backlog vs Kafka consumer lag, I immediately isolate whether the publisher or the consumer is the bottleneck."

---

### Scenario 5: Security / Compliance Leak in Application Logs
> **Question:** *"A security audit reports that session cookies, bearer tokens, or credit card numbers are appearing in production log files. How do you permanently solve this across all microservices?"*

* **Model Answer:**
  > "We solve this architecturally at the logging framework level using **automated redaction** in Pino (`common/src/logger/logger.ts`).  
  > Rather than relying on individual developers to remember not to log secrets, our centralized logger factory configures wildcards and paths:
  > - `req.headers.cookie`
  > - `req.headers.authorization`
  > - `req.headers['set-cookie']`
  > - `password`, `token`, `stripeKey`  
  > Pino intercepts and replaces these values with `[REDACTED]` before writing to stdout. This makes security compliance automatic and impossible for application code to bypass."

---

### Scenario 6: The Kubernetes Liveness/Readiness Probe Storm
> **Question:** *"Right after deploying your microservices to Kubernetes, your logs in `skaffold dev` or Datadog are spammed with thousands of lines every few minutes even with zero user traffic. What caused it and how do you fix it?"*

* **Model Answer:**
  > "In Kubernetes, Kubelet continuously executes liveness (`/healthz/live`) and readiness (`/healthz/ready`) probes against every pod every 5 to 10 seconds, and Prometheus scrapes `/metrics` every 5 seconds.  
  > If the HTTP logging middleware logs every incoming request at `info` level, health probes flood the stdout log stream.  
  > In `pinoHttp`, an exact match filter like `req.url === '/healthz'` fails because the probe hits `/healthz/live` and `/healthz/ready`.  
  > **The Fix:** In `createHttpLogger`, we configure `autoLogging.ignore` with prefix matching:  
  > `url.startsWith('/healthz') || url.startsWith('/metrics')`.  
  > This completely silences probe noise while preserving full access logging for all real user API traffic."
