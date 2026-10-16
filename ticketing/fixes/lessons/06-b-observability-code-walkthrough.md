# Phase 06: Complete Code & Architecture Walkthrough (Distributed Tracing, Structured Logging & Prometheus Metrics)

> **Purpose of this guide:**
> In Phase 06, we transformed our microservices system from a "black box" into an observable, production-grade architecture.
> When a request fails, slows down, or triggers a distributed saga across Kafka, engineers must not guess or search through disjointed terminal outputs.
> This document is your **single, self-contained reference**. It covers the architecture, the **Outbox Tracing Gotcha**, exact code implementations across `@mehul-mrtickets/common`, all microservices, and the Kubernetes observability stack (Jaeger, Prometheus, Grafana, Kafka-Exporter).

---

## 1. The Big Picture: What Problem Did We Solve?

### 1.1 The "Blind Microservices" Dilemma
Before Phase 06, diagnosing issues across services suffered from three fatal flaws:
1. **Uncorrelated `console.log` Output:** Plain strings printed to stdout without timestamps, log levels, service identity, or trace identifiers. Searching across 5 services in Kubernetes meant searching needle-in-a-haystack log streams.
2. **Severed Trace Context across Asynchronous Boundaries:** In a microservices architecture, a user action (`POST /api/orders`) triggers an HTTP request, writes to MongoDB, defers Kafka dispatch to a Transactional Outbox relay, and is processed asynchronously by Tickets, Expiration, and Payments. Standard OpenTelemetry auto-instrumentation fails because the background outbox poller runs in a disconnected context.
3. **No Real-Time System Telemetry:** We had no visibility into:
   - Request rates, error rates, and p95/p99 latencies (RED method).
   - Transactional outbox backlog or dispatch lag.
   - Circuit breaker status (`closed`, `half-open`, `open`) for Stripe.
   - Kafka consumer group lag per topic.

---

### 1.2 The 3 Pillars of Observability Implemented

```text
                     ┌─────────────────────────────────────────────────────────┐
                     │                     USER REQUEST                        │
                     └────────────────────────────┬────────────────────────────┘
                                                  │
                                                  ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│ 1. DISTRIBUTED TRACING (OpenTelemetry + Jaeger)                                             │
│ - W3C Trace Context (traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01) │
│ - Trace propagation across: HTTP -> Express -> Mongo Outbox -> Kafka -> Event Consumer      │
└─────────────────────────────────────────────┬───────────────────────────────────────────────┘
                                              │
                      ┌───────────────────────┴───────────────────────┐
                      ▼                                               ▼
┌───────────────────────────────────────────┐   ┌───────────────────────────────────────────┐
│ 2. STRUCTURED LOGGING (Pino)              │   │ 3. METRICS (Prometheus + Grafana)         │
│ - Standardized JSON output                │   │ - RED Metrics: Rate, Errors, Duration     │
│ - Sensitive header redaction (cookie, auth│   │ - Pipeline Metrics: Outbox lag, Kafka lag │
│ - Automatic trace_id & span_id correlation│   │ - Circuit Breaker state (0, 1, 2)         │
└───────────────────────────────────────────┘   └───────────────────────────────────────────┘
```

---

## 2. Deep Dive: Solving the "Outbox Tracing Disconnect" Gotcha

### 2.1 The Problem
OpenTelemetry's automatic KafkaJS instrumentation works by intercepting synchronous `producer.send({ messages: [{ value, headers }] })` calls within an active HTTP request context.
However, because we use the **Transactional Outbox Pattern** to prevent dual-write anomalies:
1. The HTTP request saves the event document to MongoDB (`OutboxEvent`) within a transaction and finishes.
2. An independent background loop (`OutboxRelay`) polls MongoDB every 200ms and sends batches of events to Kafka.
3. **Result:** When `OutboxRelay` calls `producer.send()`, the HTTP request context is already gone! The Kafka message gets a brand new root trace ID, severing the causal link between the user's action and the downstream event consumers.

```text
[BROKEN CONTEXT]:
POST /api/orders (trace_id: 1111) ──> Saves OutboxEvent in Mongo
                                         │
(HTTP request completes, context destroyed)
                                         │
OutboxRelay loop polls Mongo ────────────┴──> Calls Kafka send() (trace_id: 2222 NEW!)
                                                     │
                                                     ▼
Downstream Listener receives event with trace_id 2222 (Context Severed from 1111!)
```

---

### 2.2 The Solution: Explicit W3C Context Propagation & Active Spans across Async Boundaries

To achieve a seamless, continuous trace across the asynchronous Transactional Outbox and Kafka boundaries, two distinct requirements must be met:
1. **Context Carrier Propagation:** The W3C `traceparent` header must be injected into the MongoDB outbox record, retrieved by the poller, and passed through Kafka message headers.
2. **The "Active Span" Activation Gotcha:** Simply calling `propagation.extract(ROOT_CONTEXT, headers)` is **not enough**! It extracts a `Context` object into memory, but does *not* make any span active in Node's `AsyncLocalStorage`. If you do not call `tracer.startActiveSpan(...)`, downstream auto-instrumentations (such as Mongoose `save`, `findOne`, and Redis operations) will see `trace.getActiveSpan() === undefined` and will fail to link their spans to the trace.

```text
[UNBROKEN CONTEXT & UNIFIED WATERFALL]:
Client: POST /api/tickets (trace_id: e94765703...)
       │
       ▼
OutboxPublisher.publish(session)  [tickets service]
       │
       ├─> propagation.inject(context.active(), headers)  // headers["traceparent"] = "00-e94765703..."
       └─> Saves OutboxEvent { headers: { traceparent: "..." } } to Mongo outboxevents
              │
              ▼
OutboxRelay background worker [tickets service]
       │
       ├─> propagation.extract(ROOT_CONTEXT, cleanHeaders)
       └─> tracer.startActiveSpan("publish: ticket-events", { kind: PRODUCER }, ...)
              │
              └─> producer.send(...) (Transmits headers through Kafka wire)
                     │
                     ▼
EventConsumer [orders service]
       │
       ├─> propagation.extract(ROOT_CONTEXT, stringHeaders)
       └─> tracer.startActiveSpan("consume: ticket:created", { kind: CONSUMER }, ...)
              │
              ├── Mongoose: findOne processedevents (Idempotency check)
              ├── Mongoose: save processedevents    (Idempotency record)
              └── Mongoose: save tickets            (Replicated ticket saved in orders db!)
```

#### Exact Step 1: Injection in `common/src/outbox/outbox-publisher.ts`:
```typescript
import { context, propagation } from "@opentelemetry/api";

export abstract class OutboxPublisher<T extends Event> {
    abstract subject: T["subject"];
    abstract partitionKey(data: T["data"]): string;

    async publish(data: T["data"], session: mongoose.ClientSession): Promise<void> {
        // Capture active W3C trace context (traceparent)
        const headers: Record<string, string> = {};
        propagation.inject(context.active(), headers);

        await OutboxEvent.create(
            [
                {
                    topic: this.subject,
                    key: this.partitionKey(data),
                    payload: data,
                    headers, // Persisted directly into MongoDB outbox collection
                    status: OutboxStatus.Pending,
                },
            ],
            { session }
        );

        eventsPublishedCounter.inc({ topic: this.subject });
    }
}
```

#### Exact Step 2: Active PRODUCER Span in `common/src/outbox/outbox-relay.ts`:
```typescript
import { context, propagation, ROOT_CONTEXT, trace, SpanKind } from "@opentelemetry/api";

// Extract saved traceparent from MongoDB OutboxEvent headers
const extractedContext = propagation.extract(ROOT_CONTEXT, cleanHeaders);
const tracer = trace.getTracer("@mehul-mrtickets/common");

// Wrap Kafka producer.send in an active PRODUCER span linked to the parent HTTP request
await tracer.startActiveSpan(
    `publish: ${event.topic}`,
    {
        kind: SpanKind.PRODUCER,
        attributes: {
            "messaging.system": "kafka",
            "messaging.destination": event.topic,
            "messaging.event_type": event.eventType,
            "messaging.event_id": event.eventId,
        },
    },
    extractedContext,
    async (span) => {
        try {
            await this.producer.send({
                topic: event.topic,
                messages: [
                    {
                        key: event.key,
                        value: event.payload,
                        headers: cleanHeaders, // Transmitted on Kafka wire
                    },
                ],
            });
        } finally {
            span.end();
        }
    }
);
```

#### Exact Step 3: Active CONSUMER Span in `common/src/events/event-consumer.ts`:
```typescript
import { ROOT_CONTEXT, propagation, trace, SpanKind } from "@opentelemetry/api";

// Extract incoming W3C trace context from Kafka message headers
const rawHeaders = message.headers || {};
const stringHeaders: Record<string, string> = {};
for (const [k, v] of Object.entries(rawHeaders)) {
    if (v !== undefined && v !== null) {
        stringHeaders[k] = v.toString();
    }
}
const extractedContext = propagation.extract(ROOT_CONTEXT, stringHeaders);
const tracer = trace.getTracer("@mehul-mrtickets/common");

// Start active CONSUMER span so all downstream DB calls (Mongoose) nest cleanly
await tracer.startActiveSpan(
    `consume: ${eventType}`,
    {
        kind: SpanKind.CONSUMER,
        attributes: {
            "messaging.system": "kafka",
            "messaging.destination": topic,
            "messaging.operation": "process",
            "messaging.event_type": eventType,
            "messaging.event_id": eventId || "",
            "messaging.consumer_group": this.groupId,
        },
    },
    extractedContext,
    async (span) => {
        try {
            // Downstream execution:
            // 1. ProcessedEvent.findOne (Mongoose auto-instrumented child span)
            // 2. ProcessedEvent.create (Mongoose auto-instrumented child span)
            // 3. listener.onMessage (e.g., Ticket.save() in orders service)
            await listener.onMessage(data, { eventId, occurredAt, session });
        } finally {
            span.end();
        }
    }
);
```

#### The Resulting End-to-End Waterfall (Live Tested):
```text
[tickets]  POST /api/tickets
  ├── [tickets]  request handler - /api/tickets
  │     ├── [tickets]  save tickets                     <-- MongoDB tickets collection
  │     ├── [tickets]  save outboxevents                <-- MongoDB transactional outbox
  │     └── [tickets]  publish: ticket-events           <-- OutboxRelay PRODUCER span
  │           └── [tickets]  send ticket-events         <-- Kafka producer span
  │                 │
  │                 └── [orders]  consume: ticket:created  <-- Kafka CONSUMER span
  │                       ├── [orders]  findOne processedevents  <-- Idempotency check
  │                       ├── [orders]  save processedevents     <-- Idempotency record
  │                       └── [orders]  save tickets             <-- MongoDB orders replica save!
```

---

## 3. Structured Logging Architecture (Pino)

### 3.1 Trace Correlation & Security Redaction
In `common/src/logger/logger.ts`, we created two core factories:
1. `createLogger(serviceName)`: For general background jobs, sweepers, and startup routines.
2. `createHttpLogger(serviceName)`: Express middleware with automatic request logging.

#### Key Features:
- **Automatic Trace Injection:** The logger uses a `formatters.log` hook to inspect `trace.getActiveSpan()`. If an active OpenTelemetry span exists, `trace_id` and `span_id` are automatically stamped into every log line.
- **Sensitive Data Redaction:** Headers matching `cookie`, `authorization`, `set-cookie`, `password`, and `stripeKey` are automatically masked as `[REDACTED]`.

```typescript
// common/src/logger/logger.ts
export const createLogger = (serviceName: string): Logger => {
    return pino({
        level: process.env.LOG_LEVEL || "info",
        redact: {
            paths: [
                "req.headers.authorization",
                "req.headers.cookie",
                "req.headers['set-cookie']",
                "password",
                "stripeKey",
                "token",
            ],
            censor: "[REDACTED]",
        },
        formatters: {
            log(object) {
                const activeSpan = trace.getActiveSpan();
                if (activeSpan) {
                    const spanContext = activeSpan.spanContext();
                    return {
                        ...object,
                        trace_id: spanContext.traceId,
                        span_id: spanContext.spanId,
                    };
                }
                return object;
            },
        },
        base: { service: serviceName },
        timestamp: pino.stdTimeFunctions.isoTime,
    });
};
```

### 3.2 Suppressing Kubernetes Probe Spam (`createHttpLogger`)
In Kubernetes, Kubelet continuously executes liveness (`/healthz/live`) and readiness (`/healthz/ready`) probes against every pod every 5 to 10 seconds. Prometheus also scrapes `/metrics` every 5 seconds.
If these requests are logged at `info` level, developer terminals (`skaffold dev`) and log aggregators will be overwhelmed by endless probe log noise.

To prevent this without disabling useful application access logs, `createHttpLogger` specifies an `autoLogging.ignore` filter checking `url.startsWith(...)`:

```typescript
// common/src/logger/logger.ts
export const createHttpLogger = (serviceName: string) => {
    const logger = createLogger(serviceName);
    return pinoHttp({
        logger,
        autoLogging: {
            ignore: (req) => {
                const url = req.url || "";
                // Suppress /healthz/live, /healthz/ready, and /metrics
                return url.startsWith("/healthz") || url.startsWith("/metrics");
            },
        },
        customLogLevel: (_req, res, err) => {
            if (res.statusCode >= 500 || err) return "error";
            if (res.statusCode >= 400) return "warn";
            return "info";
        },
    });
};
```

---

## 4. Prometheus RED & Pipeline Metrics

### 4.1 Cardinality Protection (`getRoutePattern`)
A notorious production failure with Prometheus occurs when dynamic parameters (e.g. `/api/tickets/65f9a...`) are used as metric labels. A million unique IDs generate a million time-series, crashing the Prometheus TSDB.

In `common/src/metrics/metrics.ts`, we implemented `getRoutePattern` to normalize routes using Express route matching metadata (`req.route.path`):

```typescript
export const getRoutePattern = (req: Request): string => {
    if (req.route && req.route.path) {
        const baseUrl = req.baseUrl || "";
        return `${baseUrl}${req.route.path}`; // E.g. /api/tickets/:id
    }
    return req.path || "unknown";
};
```

### 4.2 Standard Metric Definitions
All metrics are registered in a single isolated registry and exported via `/metrics`:
- **`ticketing_http_requests_total`**: Rate and error counter with labels `[service, method, route, status_code]`.
- **`ticketing_http_request_duration_seconds`**: Duration histogram with custom latency buckets: `[0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]`.
- **`ticketing_events_published_total`**: Outbox publish counter by `topic`.
- **`ticketing_events_consumed_total`**: Consumption counter with labels `[topic, event_type, result]`.
- **`ticketing_outbox_pending_events`**: Gauge tracking pending events in MongoDB outbox table.
- **`ticketing_outbox_publish_lag_seconds`**: Histogram tracking time elapsed from creation to Kafka dispatch.
- **`ticketing_circuit_breaker_state`**: Gauge tracking external dependencies (Stripe: 0=closed, 1=half-open, 2=open).
- **`ticketing_orders_swept_total`**: Counter for stale orders cleaned by background sweeper.

---

## 5. Service-by-Service Instrumentation

### 5.1 The Rule of Line 1
OpenTelemetry monkey-patches standard library modules (`http`, `https`, `net`) and frameworks (`express`, `kafkajs`). Therefore:
> **The tracing initialisation MUST be the very first import on Line 1 of `index.ts`.** If `express` or `http` is imported before `startTracing()`, those modules will not be patched and requests will not be traced.

```typescript
// auth/src/index.ts, tickets/src/index.ts, orders/src/index.ts, payments/src/index.ts
import "./tracing"; // <--- MUST BE LINE 1!
import mongoose from "mongoose";
import { app } from "./app";
// ...
```

### 5.2 Express App Instrumentation
In every service `app.ts`:
```typescript
// Observability: Metrics and HTTP request logger
app.use(metricsMiddleware);
app.use(metricsRouter); // Serves GET /metrics
if (process.env.NODE_ENV !== "test") {
    app.use(createHttpLogger("<service-name>"));
}
```

### 5.3 Payments Service: Circuit Breaker Telemetry
In `payments/src/services/stripe-client.ts`, we wired event listeners from Opossum directly into Prometheus gauges:
```typescript
// Circuit Breaker Metrics (0 = closed, 1 = half-open, 2 = open)
circuitBreakerStateGauge.set({ name: "stripe_charge" }, 0);
circuitBreakerStateGauge.set({ name: "stripe_refund" }, 0);

chargeBreaker.on("open", () => circuitBreakerStateGauge.set({ name: "stripe_charge" }, 2));
chargeBreaker.on("halfOpen", () => circuitBreakerStateGauge.set({ name: "stripe_charge" }, 1));
chargeBreaker.on("close", () => circuitBreakerStateGauge.set({ name: "stripe_charge" }, 0));

refundBreaker.on("open", () => circuitBreakerStateGauge.set({ name: "stripe_refund" }, 2));
refundBreaker.on("halfOpen", () => circuitBreakerStateGauge.set({ name: "stripe_refund" }, 1));
refundBreaker.on("close", () => circuitBreakerStateGauge.set({ name: "stripe_refund" }, 0));
```

### 5.4 Orders Service: Background Sweeper Telemetry
In `orders/src/jobs/expire-orders-sweeper.ts`:
```typescript
if (sweptCount > 0) {
    ordersSweptCounter.inc({ service: "orders" }, sweptCount);
    logger.info({ sweptCount }, "[ExpireOrdersSweeper] Swept and cancelled expired orders");
}
```

---

## 6. Kubernetes Observability Stack (`infra/k8s/observability/`)

| Component | Manifest | Key Capabilities |
| :--- | :--- | :--- |
| **Jaeger** | `jaeger.yaml` | All-In-One distributed trace store. OTLP gRPC (4317), OTLP HTTP (4318), Web UI (16686). |
| **Prometheus** | `prometheus.yaml` | 5s scrape interval, RBAC for Kubernetes Pod Discovery, automated scraping of pods with `prometheus.io/scrape: "true"`. Alert rules for ServiceDown, HighErrorRate (>5%), HighOutboxLag (>50), CircuitBreakerOpen, and HighKafkaLag. |
| **Kafka Exporter** | `kafka-exporter.yaml` | Scrapes Kafka cluster (`kafka-0.kafka-srv:9092`) and calculates consumer group lag per partition. |
| **Grafana** | `grafana.yaml` | Auto-provisioned Prometheus datasource and 3 dashboards: **Service Overview (RED)**, **Event Pipeline & Kafka Lag**, and **Business Metrics**. |

### 6.1 Critical Kubernetes Manifest Gotchas

1. **Jaeger OTLP HTTP Endpoint Path:**
   OpenTelemetry's Node.js `OTLPTraceExporter` requires the exact endpoint path:
   ```yaml
   env:
     - name: OTEL_EXPORTER_OTLP_ENDPOINT
       value: "http://jaeger-srv:4318/v1/traces"  # Must include /v1/traces!
   ```
   *Gotcha:* If set to `http://jaeger-srv:4318`, Jaeger returns HTTP 404 and drops all spans silently.

2. **Prometheus Target Label Relabeling:**
   Our pods are labeled with `app: orders`, `app: tickets`, etc. In `prometheus.yaml`, we added a relabel config:
   ```yaml
   relabel_configs:
     - source_labels: [__meta_kubernetes_pod_label_app]
       target_label: service
   ```
   This ensures that Prometheus metrics like `ticketing_http_requests_total` can be queried in Grafana using `by (service)` consistently.

### Accessing Dashboards Locally:
```bash
# Grafana (User interface on http://localhost:3001)
kubectl port-forward svc/grafana-srv 3001:3000

# Jaeger UI (Distributed tracing on http://localhost:16686)
kubectl port-forward svc/jaeger-srv 16686:16686

# Prometheus UI (PromQL queries and alert statuses on http://localhost:9090)
kubectl port-forward svc/prometheus-srv 9090:9090
```

---

## 7. Verification & Live Trace Proof

### 7.1 Automated Microservice Test Suites
Every microservice was validated against its comprehensive test suite with the new observability middleware and OpenTelemetry runtime:

| Microservice | Test Command | Test Suites | Tests | Status |
| :--- | :--- | :--- | :--- | :--- |
| **Auth** | `npm run test:ci` | 5 / 5 passed | 13 / 13 passed |  PASS |
| **Tickets** | `npm run test:ci` | 8 / 8 passed | 24 / 24 passed |  PASS |
| **Orders** | `npm run test:ci` | 11 / 11 passed | 30 / 30 passed |  PASS |
| **Payments** | `npm run test:ci` | 6 / 6 passed | 18 / 18 passed |  PASS |
| **Total** | | **30 / 30 suites** | **85 / 85 tests** | **100% PASS** |

### 7.2 Live Cluster Verification (Trace ID: `e94765703abc8b24209641e629214c36`)
A live `POST /api/tickets` request was triggered in the Kubernetes cluster. Jaeger recorded 19 spans across multiple services in a single unified waterfall:
1. `tickets`: `POST /api/tickets` (Express server span)
2. `tickets`: `save tickets` (Mongoose DB write)
3. `tickets`: `save outboxevents` (Transactional outbox DB write)
4. `tickets`: `publish: ticket-events` -> `send ticket-events` (Kafka Producer span via `OutboxRelay`)
5. `orders`: `consume: ticket:created` (Kafka Consumer span via `EventConsumer`)
6. `orders`: `findOne processedevents` (Idempotency check)
7. `orders`: `save processedevents` (Idempotency recorded)
8. `orders`: `save tickets` (Mongoose replicated ticket saved in `orders` database!)

All five microservices (`auth`, `tickets`, `orders`, `payments`, `expiration`) are registered in Jaeger and reporting active metrics to Prometheus.
