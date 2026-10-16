# Phase 06: Observability (Logs, Distributed Tracing & Metrics)

> **Core Theme:** In a distributed system, failure is inevitable. When a customer reports *"my payment went through but I didn't get my ticket"*, you cannot log into 5 different servers and manually match timestamps. Observability gives you the power to see **what** happened (logs), **where** it happened across hops (traces), and **how bad / how often** (metrics), all unified by a single `traceId`.

---

## 1. The 3 Pillars of Observability & Their Glue

In traditional monolithic apps, logging to a text file with `console.log()` was often "good enough." In our event-driven microservices architecture:
1. A user clicks "Purchase" in the browser.
2. The request hits `ingress-nginx` ➔ `orders` service.
3. `orders` writes to MongoDB and appends to the `outbox_events` collection.
4. `OutboxRelay` asynchronously publishes `order:created` to Kafka topic `order-events`.
5. `tickets` consumes the event and locks the ticket.
6. `expiration` consumes the event and queues a Bull/Redis timer.
7. The user pays via `payments` service, which talks to Stripe and publishes `payment:created`.
8. `orders` consumes `payment:created` and marks the order complete.

If step 7 fails, or takes 15 seconds: **where is the bottleneck?** Did Stripe stall? Did Kafka drop the message? Did the Outbox relay lag? Did MongoDB lock?

```text
 ┌────────────────────────────────────────────────────────────────────────┐
 │                              OBSERVABILITY                             │
 ├───────────────────┬───────────────────────────────┬────────────────────┤
 │    1. LOGS        │           2. TRACES           │     3. METRICS     │
 │  (What happened)  │    (Where & when it hopped)   │ (How often/healthy)│
 ├───────────────────┼───────────────────────────────┼────────────────────┤
 │ Structured JSON   │ OpenTelemetry Spans & Jaeger  │ Prometheus &       │
 │ with Pino         │ Waterfall across HTTP, DB,    │ Grafana Dashboards │
 │ Level, timestamp, │ Kafka, and async outbox       │ RED method,        │
 │ service, message  │                               │ consumer lag       │
 └─────────┬─────────┴───────────────┬───────────────┴──────────┬─────────┘
           │                         │                          │
           └────────────────►   trace_id   ◄────────────────────┘
                               (The Glue)
```

### The Glue: `trace_id`
* **Log-to-Trace correlation:** Every log line printed by Pino automatically includes `trace_id` and `span_id`. Copy the `trace_id` from a log error, paste it into Jaeger, and you instantly see the entire lifecycle of that exact request across all 5 services.
* **Metric-to-Trace correlation (Exemplars):** A spike in the Prometheus p99 latency graph links directly to a sample trace that caused the spike.

---

## 2. Pillar 1: Structured Logging with Pino

### Why `console.log` is Forbidden in Production
1. **Unstructured String:** `console.log("Connected to Mongo!!!")` cannot be queried by log aggregators (Elasticsearch, Loki, Datadog). You cannot filter by `service == "orders"` or `statusCode >= 500`.
2. **Synchronous I/O in Node:** In older Node versions and certain runtimes, `console.log` can block the event loop under heavy throughput.
3. **Missing Context:** It contains no request ID, user ID, or trace correlation.
4. **Security Vulnerability:** Logging raw objects often leaks Authorization Bearer tokens, passwords, and session cookies into log sinks.

### The Pino Solution
* Blazing fast JSON logger.
* Automatic injection of `trace_id` and `span_id` via OpenTelemetry instrumentation.
* Automatic **redaction** of sensitive fields (`req.headers.cookie`, `req.headers.authorization`).

```json
{
  "level": 30,
  "time": 1739000000000,
  "service": "orders",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id": "00f067aa0ba902b7",
  "orderId": "67b0d9...",
  "ticketId": "67b0d1...",
  "msg": "Order created"
}
```

---

## 3. Pillar 2: Distributed Tracing (OpenTelemetry + Jaeger)

### What is a Trace and a Span?
* **Trace:** The complete end-to-end journey of a transaction through a distributed system.
* **Span:** A single unit of work within that trace (e.g., an HTTP request, a database query, or a Kafka publish). Each span has a name, start time, duration, and metadata (tags/attributes).

```text
Trace: POST /api/orders [Total: 85ms]
├── [orders] HTTP POST /api/orders (85ms)
│   ├── [orders] mongo: tickets.findOne (12ms)
│   ├── [orders] mongo: transaction commit (18ms)
│   └── [orders] outbox_relay: kafka.produce order:created (8ms)
│
└── [tickets] kafka.consume order:created (25ms)
    └── [tickets] mongo: tickets.updateOne (14ms)
```

### The Critical "Transactional Outbox Gotcha" in Distributed Tracing

This is one of the most famous real-world architecture interview questions:

> **Interview Question:** *"We use OpenTelemetry auto-instrumentation and Kafka. When we migrated from direct Kafka publishing to the Transactional Outbox pattern, all our distributed traces broke into disconnected pieces. Why did that happen, and how do you fix it?"*

#### Why it breaks:
1. In standard auto-instrumentation, when code calls `kafkaProducer.send()`, OpenTelemetry grabs the active HTTP trace context from memory (`AsyncLocalStorage`) and injects the W3C `traceparent` header into the Kafka message headers.
2. BUT with the Transactional Outbox pattern:
   - The Express request handler **does not call Kafka**. It only writes an `OutboxEvent` row into MongoDB! The HTTP request completes, and the trace **finishes**.
   - 200 milliseconds later, an asynchronous background loop (`OutboxRelay`) wakes up. It reads pending rows from MongoDB and calls `kafkaProducer.send()`.
   - At this moment, the `OutboxRelay` is running in a background timer context. It has **no idea** what HTTP request originally created that event!
   - Result: Auto-instrumentation either creates a brand-new detached trace starting at the relay, or leaves the Kafka headers empty. The trace is severed!

#### How we fix it (Async Context Preservation):
We bridge the async gap in `@mehul-mrtickets/common`:
1. **When publishing to the outbox (`OutboxPublisher.publish`):**
   ```ts
   const headers: Record<string, string> = {};
   // Capture active W3C trace context from the current HTTP request:
   propagation.inject(context.active(), headers);
   // Store headers inside the MongoDB OutboxEvent document!
   await OutboxEvent.create([{ ...data, headers }], { session });
   ```
2. **When relaying to Kafka (`OutboxRelay`):**
   ```ts
   // Extract saved headers and start an active PRODUCER span linked to the parent HTTP request
   const extractedContext = propagation.extract(ROOT_CONTEXT, cleanHeaders);
   const tracer = trace.getTracer("@mehul-mrtickets/common");

   await tracer.startActiveSpan(
       `publish: ${event.topic}`,
       { kind: SpanKind.PRODUCER, attributes: { "messaging.system": "kafka", "messaging.destination": event.topic } },
       extractedContext,
       async (span) => {
           try {
               await producer.send({
                   topic: event.topic,
                   messages: [{ key: event.key, value: event.payload, headers: cleanHeaders }]
               });
           } finally {
               span.end();
           }
       }
   );
   ```
3. **When consuming from Kafka (`EventConsumer`):**
   ```ts
   // Extract incoming W3C trace context from Kafka headers and start an active CONSUMER span
   const extractedContext = propagation.extract(ROOT_CONTEXT, stringHeaders);
   const tracer = trace.getTracer("@mehul-mrtickets/common");

   await tracer.startActiveSpan(
       `consume: ${eventType}`,
       { kind: SpanKind.CONSUMER, attributes: { "messaging.system": "kafka", "messaging.destination": topic } },
       extractedContext,
       async (span) => {
           try {
               // Any child operations (e.g. Mongoose findOne/save) now nest directly under this span!
               await listener.onMessage(data, metadata);
           } finally {
               span.end();
           }
       }
   );
   ```
Result: **A 100% continuous, unbroken trace** spanning the initial browser HTTP call, MongoDB transaction, the Outbox table, the Kafka network jump, and all downstream consumer services (with child DB spans nested inside)!

---

## 4. Pillar 3: Metrics (Prometheus + Grafana)

While traces give deep diagnostic drill-downs into individual requests, **Metrics** give aggregate system health.

### The RED Method for Request-Driven Services
For every service API, we measure:
* **R (Rate):** Requests per second (`http_requests_total`).
* **E (Errors):** Number of failed requests (`http_requests_total{status=~"5.."}`).
* **D (Duration):** Latency distribution (`http_request_duration_seconds` histogram for p50, p95, p99).

### System & Pipeline Metrics
In an event-driven system, HTTP metrics alone are not enough. We track pipeline health:
1. **Consumer Lag (`kafka_consumergroup_lag`):** The number of messages published to Kafka that a consumer group has not yet processed. High or growing lag means consumers are falling behind or deadlocked!
2. **Outbox Backlog (`outbox_pending_events`):** Count of events in MongoDB with `status: "pending"`. If this rises, the OutboxRelay is failing or Kafka is down.
3. **Circuit Breaker State (`circuit_breaker_state`):** 0 = Closed (Healthy), 1 = Half-Open (Testing), 2 = Open (Failing Fast).
4. **Sweeper Invocations (`orders_swept_total`):** Tracks how many stale orders the background sweeper had to rescue. Normally near 0; an increase indicates the Bull/Redis fast path is broken.

### The High-Cardinality Trap (Critical Prometheus Concept)
In Prometheus, each unique combination of key-value label pairs creates a **new time-series in memory**.
* **Good (Low Cardinality):** `route: "/api/orders/:orderId"` ➔ fixed number of routes (e.g., 20 routes total).
* **Catastrophic (High Cardinality):** `route: "/api/orders/65f2a1b94..."` or adding `userId` or `orderId` as a Prometheus label!
  * If 100,000 users create orders, Prometheus creates 100,000 unique time series, consuming gigabytes of RAM until the Prometheus pod crashes with an Out-Of-Memory (OOM) kill.
  * **Rule:** Prometheus labels must only use bounded enums or route patterns, never raw dynamic IDs!

---

## 5. Phase 06 Implementation Plan

```text
                                  PHASE 06 ARCHITECTURE
                                  
  Microservices (Node.js)                                      Observability Stack (K8s)
 ┌──────────────────────────────────────────────┐              ┌───────────────────────────┐
 │ orders / payments / tickets / auth           │              │                           │
 │                                              │              │                           │
 │ 1. tracing.ts (Loaded 1st! OTel SDK)         ├──── OTLP ───►│ Jaeger (UI :16686)        │
 │ 2. logger.ts  (Pino JSON + trace_id)         │              │                           │
 │ 3. /metrics   (prom-client + RED + pipeline) ├◄── Scrape ───┤ Prometheus (Port :9090)   │
 │ 4. Outbox traceparent preservation           │              │     │                     │
 └──────────────────────────────────────────────┘              │     ▼                     │
                                                               │ Grafana (Port :3000)      │
                                                               │  - Service Overview       │
                                                               │  - Event Pipeline         │
                                                               │  - Business Dashboard     │
                                                               └───────────────────────────┘
```

1. **In `@mehul-mrtickets/common`:**
   * Build `tracing.ts` with OpenTelemetry auto-instrumentations for HTTP, Express, Mongoose, KafkaJS, and Redis.
   * Build `logger.ts` with Pino, redaction rules, and OTel log correlation.
   * Build `metrics.ts` defining Prometheus registry, RED histograms, pipeline gauges, and `/metrics` router.
   * Add W3C `traceparent` injection in `OutboxPublisher` and extraction in `EventConsumer`.
2. **In Services (`orders`, `payments`, `tickets`, `auth`, `expiration`):**
   * Load `tracing.ts` as the very first import.
   * Add `pino-http` request logging.
   * Expose `/metrics` endpoint.
   * Replace `console.log` with structured `logger.info()`.
3. **In Kubernetes Infrastructure (`infra/k8s/observability/`):**
   * Deploy Jaeger (`jaegertracing/all-in-one`).
   * Deploy Prometheus with Kubernetes pod auto-scraping annotations.
   * Deploy Grafana with pre-configured datasources and 3 dashboards (Service Overview, Event Pipeline, Business Metrics).
   * Deploy `kafka-exporter` for consumer lag monitoring.
4. **Verification & Tests:**
   * Unit tests for metrics, logger redaction, and traceparent propagation.
   * Live end-to-end trace verification in Jaeger.
   * Prometheus scrape and Grafana dashboard verification.

---

### Key Interview Takeaways to Remember
1. **Three Pillars:** Logs tell you *what* happened; Traces tell you *where* it happened across microservice boundaries; Metrics tell you *how often* and system health.
2. **The Glue:** A single `trace_id` links all three together.
3. **The Outbox Gotcha:** Because the Transactional Outbox decouples the DB write from Kafka publishing, trace context must be explicitly captured into the database record and restored during relay dispatch.
4. **Cardinality:** Never put dynamic IDs (`orderId`, `userId`, raw URLs) into Prometheus labels.

> 💡 **Detailed Interview Prep:** For full model answers to 6 real-world scenario questions (Broken Async Traces, Prometheus OOM, Intermittent 500 drill-down, Queue Stalls, Compliance log leaks, and Kubelet probe storms), see [06-observability.md Section 6](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/fixes/notes/06-observability.md#6-scenario-based-interview-questions--model-answers).
