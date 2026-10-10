# Phase 06 — Observability (Logs, Traces, Metrics)

**Goal:** When something goes wrong, be able to answer **what** happened (logs), **where** it happened across
services (traces), and **how often / how bad** (metrics), all linked by one `traceId`.

**Grouped because:** logs, traces and metrics are the three pillars of observability. They share the same
instrumentation setup, and they only become really useful when they are linked together.

**Depends on:** Phases 03–05 (instrument the final event flows once, not twice).

---

## 1. Current State

| Pillar | Today | Problem |
|---|---|---|
| Logs | `console.log("Connected to Mongo!!!")`, `console.error(e)` | Unstructured, no request id, no service name, can't search or filter |
| Traces | None | A purchase touches 5 services. When it fails, there is no way to follow it |
| Metrics | None | No idea about latency, error rate, consumer lag, outbox backlog, DLQ size |

---

## 2. Target Architecture

```text
 ┌──────────── each Node service ─────────────┐
 │  tracing.ts  (OpenTelemetry SDK, loaded 1st)│──── OTLP ────► Jaeger      (traces UI)
 │  logger.ts   (Pino, JSON, + trace_id)       │──── stdout ──► kubectl logs (Loki optional)
 │  /metrics    (prom-client)                  │◄─── scrape ─── Prometheus ──► Grafana (dashboards + alerts)
 └─────────────────────────────────────────────┘
                                                kafka-exporter ──► Prometheus (consumer lag)
```

All observability manifests live in `infra/k8s/observability/` and are added to `skaffold.yaml` as a separate
manifest path, so the stack can be turned off on a low-RAM machine.

---

## 3. Structured Logging (Pino)

### Why Pino
Fastest JSON logger for Node, and it has an official OpenTelemetry instrumentation that injects `trace_id` / `span_id`
into every log line automatically.

### Code
`common/src/logger.ts`:
```ts
import pino from "pino";

export const createLogger = (serviceName: string) => {
    return pino({
        level: process.env.LOG_LEVEL || "info",
        base: { service: serviceName },
        redact: ["req.headers.cookie", "req.headers.authorization"]
    });
};
```

Each service has a one-line `src/logger.ts`:
```ts
export const logger = createLogger("orders");
```

- `pino-http` middleware in `app.ts` logs every request (method, route, status, duration).
- Every `console.log` / `console.error` is replaced with `logger.info` / `logger.error` with context objects:
  ```ts
  logger.info({ orderId: order.id, ticketId: ticket.id }, "Order created");
  ```
- The base consumer logs `{ topic, eventType, eventId, attempt }` on retries and DLQ sends.
- **Cookies and JWTs are redacted.** Never log secrets.

### Example output
```json
{"level":30,"time":1739000000000,"service":"orders","trace_id":"4bf92f35...","span_id":"00f067aa...","orderId":"65f...","msg":"Order created"}
```

---

## 4. Distributed Tracing (OpenTelemetry + Jaeger)

### Setup
`src/tracing.ts` in each service (identical code, so it comes from common as `startTracing(serviceName)`):
- `@opentelemetry/sdk-node` + `@opentelemetry/auto-instrumentations-node`
- Auto-instrumented: **http, express, mongoose/mongodb, kafkajs, ioredis, pino**
- Exporter: OTLP HTTP → `http://jaeger-srv:4318`
- Must be the **first import** in `index.ts`, before express and mongoose are loaded, otherwise they are not patched.

### Context propagation across the system
```text
 Browser ─► Ingress ─► orders (HTTP span)
                         ├─ mongo: insert order         (child span)
                         └─ mongo: insert outbox row    ← traceparent SAVED in the row's headers
                                    ⋮  (later, different async context)
                       OutboxRelay ─► kafka send        ← traceparent RESTORED from the row
                                    ⋮
                       tickets consumer (kafkajs span, parent = same trace)
                         └─ mongo: update ticket
                       expiration consumer ...
                       payments consumer ...
```

### The outbox gotcha (a good interview topic)
Auto-instrumentation propagates context through the Kafka headers of `producer.send()`. But with the outbox, the send
happens **later, in the relay loop**, with no active request context, so the trace would be cut in two.

Fix (≈10 lines in common):
- `OutboxPublisher.publish()` calls `propagation.inject(context.active(), headers)` and stores the headers on the outbox row.
- `OutboxRelay` sends the stored headers with the Kafka message.
- `EventConsumer` calls `propagation.extract()` from the message headers and runs `onMessage` inside that context.

Result: **one trace** from the HTTP request to every downstream consumer, even though the event waited in a database table.

### Sampling
100% locally. In production you would use a parent-based ratio sampler (e.g. 10%) plus "always sample errors"
through tail sampling in an OTel Collector. Document this, don't build it.

---

## 5. Metrics (Prometheus + Grafana)

### `/metrics` endpoint
`common/src/metrics.ts` exports a shared `prom-client` registry and a `metricsRouter`. Default Node metrics
(event loop lag, heap, GC) are enabled. `/metrics` is served on the same port, but **only matched by Prometheus**:
the ingress only routes `/api/*` and `/` (client), so it is not public.

### What we measure: RED for APIs + system-specific signals
| Metric | Type | Labels | Why |
|---|---|---|---|
| `http_request_duration_seconds` | Histogram | method, route, status_code | **R**ate, **E**rrors, **D**uration |
| `events_published_total` | Counter | topic, event_type | Throughput per event |
| `events_consumed_total` | Counter | topic, event_type, result (`ok`/`retry`/`dlq`/`duplicate`) | Consumer health, duplicate rate |
| `outbox_pending_events` | Gauge | service | Relay falling behind / Kafka down |
| `outbox_publish_lag_seconds` | Histogram | service | Time from outbox insert to Kafka |
| `circuit_breaker_state` | Gauge | name (`stripe-charge`) | 0 closed, 1 half-open, 2 open |
| `orders_swept_total` | Counter | – | Should be ~0. If not, the expiry fast path is broken |
| `kafka_consumergroup_lag` | Gauge | group, topic, partition | From **kafka-exporter**. The #1 Kafka health metric |

`route` uses the **route pattern** (`/api/orders/:orderId`), never the raw URL, to avoid a label-cardinality explosion.

### Prometheus
- `infra/k8s/observability/prometheus.yaml`: Deployment + ConfigMap + ServiceAccount/RBAC.
- Kubernetes service discovery: scrapes pods annotated with `prometheus.io/scrape: "true"` and `prometheus.io/port: "3000"`.
- Plain manifests instead of `kube-prometheus-stack`, so every line is understandable.

### Grafana
- `infra/k8s/observability/grafana.yaml` with a provisioned Prometheus datasource and dashboards from a ConfigMap.
- Dashboards (JSON committed to the repo):
  1. **Service Overview**: RPS, error %, p50/p95/p99 per service and route.
  2. **Event Pipeline**: publish/consume rate per topic, consumer lag, outbox backlog, DLQ count, duplicates.
  3. **Business**: orders created/min, payments/min, refunds, swept orders, breaker state.

### Alerts (Prometheus rules)
| Alert | Condition | Why it matters |
|---|---|---|
| HighErrorRate | 5xx > 5% for 5m | Users are failing |
| HighLatency | p95 > 1s for 5m | Users are waiting |
| ConsumerLagGrowing | lag > 1000 for 10m | Events not processed; reservations are stale |
| DLQNotEmpty | `increase(events_consumed_total{result="dlq"}[10m]) > 0` | Possibly a stuck refund (Phase 05) |
| OutboxBacklog | `outbox_pending_events > 500` for 5m | Kafka unreachable or relay dead |
| CircuitOpen | `circuit_breaker_state == 2` | Payments are down |

Alertmanager routing (Slack, PagerDuty) is documented but not deployed.

---

## 6. Infrastructure Files

```text
infra/k8s/observability/
├── jaeger.yaml            jaegertracing/all-in-one (OTLP 4317/4318, UI 16686), in-memory storage
├── prometheus.yaml        Deployment, ConfigMap (scrape config + alert rules), RBAC
├── grafana.yaml           Deployment, datasource + dashboard ConfigMaps
├── grafana-dashboards/    *.json
└── kafka-exporter.yaml    danielqsj/kafka-exporter
```
UIs are reached with `kubectl port-forward` (Jaeger 16686, Grafana 3000, Prometheus 9090), not through the ingress.

---

## 7. Tests

| Test | Where |
|---|---|
| `/metrics` returns Prometheus text format | each service `app` test |
| HTTP histogram uses the route pattern label | `common` |
| `traceparent` stored on the outbox row and sent by the relay | `common` |
| Consumer runs `onMessage` inside the extracted context | `common` |
| Logger redacts the cookie header | `common` |

---

## 8. Verification

| Check | Expected |
|---|---|
| Place an order in the UI → open Jaeger, search by service `orders` | **One trace** with spans from orders → tickets, expiration, payments |
| Copy `trace_id` from a log line → paste into Jaeger | Same trace |
| Run `purchase-flow.js` with Grafana open | Live RPS / latency / lag graphs |
| Scale Kafka to 0 | `OutboxBacklog` alert fires; recovers after scale-up |
| Force a DLQ message | `DLQNotEmpty` fires |

Save **screenshots** of the trace waterfall and the dashboards in `results/phase-06-observability/`.
They make a strong visual for your README and resume.

---

## 9. Interview Angle

- **Three pillars** and how they connect (trace_id in logs, exemplars in metrics).
- **RED** (requests) vs **USE** (resources) methods.
- **Context propagation**: W3C `traceparent`, and why the outbox breaks it and how we fixed that.
- **Cardinality**: why `route` must be a pattern and why `userId` must never be a label.
- **Consumer lag** as the most important metric of an event-driven system.
- **Sampling strategies**: head vs tail sampling.
- **SLI / SLO** example: "99% of `POST /api/orders` under 500ms over 30 days". Know how you'd compute it from the histogram.

---

## 10. Checklist

- [ ] Concept lesson written in `fixes/lessons/06-observability-metrics-traces-logs.md`, taught & discussed in detail, and explicit go-ahead signal received from developer
- [ ] common: `createLogger`, `startTracing`, `metricsRouter` + metrics, outbox/consumer context propagation
- [ ] All services: tracing first import, logger, pino-http, metrics router, no `console.*` left
- [ ] Business / pipeline metrics wired (outbox, consumer, breaker, sweeper)
- [ ] Jaeger, Prometheus (+ rules), Grafana (+ 3 dashboards), kafka-exporter deployed
- [ ] Pod annotations for scraping
- [ ] End-to-end trace verified, screenshots saved
- [ ] `notes/06-observability.md` written
