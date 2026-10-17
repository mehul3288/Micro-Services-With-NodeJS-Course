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

### 2.5 The Telemetry Pipeline: How Data Reaches Each Tool (Theoretical Architecture)

Understanding how telemetry data travels from your application code to each respective tool is critical for system design interviews:

```text
                                  HOW TELEMETRY DATA FLOWS
                                  
  Microservice Pod (Node.js)                              Observability Destination
 ┌──────────────────────────────────────────────┐        ┌────────────────────────────┐
 │ 1. Logs (Pino)                               │        │ stdout / Log Aggregator    │
 │    - Writes JSON string to standard output   ├───────►│ (Docker/K8s node daemon,   │
 │                                              │        │  FluentBit, Loki, Datadog) │
 │                                              │        └────────────────────────────┘
 │                                              │
 │ 2. Traces (OpenTelemetry SDK)                │        ┌────────────────────────────┐
 │    - In-memory span buffer                   │  PUSH  │ Jaeger Collector           │
 │    - Env: OTEL_EXPORTER_OTLP_ENDPOINT        ├───────►│ (Listens on port 4318      │
 │           http://jaeger-srv:4318/v1/traces   │ (OTLP) │  via HTTP POST /v1/traces) │
 │                                              │        └────────────────────────────┘
 │                                              │
 │ 3. Metrics (prom-client)                     │        ┌────────────────────────────┐
 │    - In-memory counters & histograms         │  PULL  │ Prometheus Server          │
 │    - Exposes GET /metrics endpoint           │◄───────┤ (Scrapes every 5 seconds   │
 │    - Annotations: prometheus.io/scrape=true  │(Scrape)│  via K8s Pod Discovery)    │
 └──────────────────────────────────────────────┘        └─────────────┬──────────────┘
                                                                       │
                                                         Query On      │ PromQL
                                                         Demand        ▼
                                                         ┌────────────────────────────┐
                                                         │ Grafana Dashboards         │
                                                         │ (Port 3000, renders graphs │
                                                         │  by querying Prometheus)   │
                                                         └────────────────────────────┘
```

### Tool-by-Tool: What It Does & How Data Reaches It

#### 1. Pino (Structured Logging)
* **What it is:**  
  A blazing-fast, low-overhead JSON logging library designed specifically for Node.js. Unlike older loggers (like Winston) that can block the Node.js event loop with heavy string formatting, Pino is engineered for extreme throughput, outputs pure machine-parseable JSON lines, and includes built-in security redaction for sensitive fields.
* **What it is used for:**  
  Recording discrete application events, HTTP access logs, and errors in structured JSON (e.g., *"Order #123 created"*, *"Stripe charge failed"*).
* **Data Delivery Model: `stdout` (Standard Output)**  
  Applications in containers should **never** write directly to log files on disk (disks are wiped when pods restart). Instead, Pino prints structured JSON strings directly to the container's standard output stream (`stdout`).
* **How it is configured so data reaches it:**  
  1. The container runtime (Docker / containerd) automatically intercepts whatever the Node.js process prints to `stdout` and writes it to `/var/log/pods/...` on the host node.
  2. In local development, `kubectl logs` reads directly from that stream. In production, a log daemon (like FluentBit, Promtail, or Datadog agent) scrapes those files and ships them to a centralized log warehouse (Loki, Elasticsearch, or CloudWatch).

---

#### 2. OpenTelemetry & Jaeger (Distributed Tracing)
* **What OpenTelemetry (OTel) is:**  
  A vendor-neutral, CNCF (Cloud Native Computing Foundation) industry-standard framework. It provides standardized APIs, SDKs, and auto-instrumentations to generate and export telemetry data (traces, metrics) without locking you into proprietary commercial vendors (like Datadog, Dynatrace, or New Relic).
* **What Jaeger is:**  
  An open-source distributed tracing backend and web UI (originally built by Uber, now a CNCF graduated project). It ingests OTLP trace spans, reconstructs the parent-child causal relationships between asynchronous microservices, and renders the interactive timeline waterfall.
* **What it is used for:**  
  Recording the timing and causal relationships of requests as they travel across network boundaries (HTTP ➔ MongoDB ➔ Outbox ➔ Kafka ➔ Consumer) to draw **waterfall diagrams**.
* **Data Delivery Model: PUSH Model (OTLP / HTTP)**  
  The application **actively pushes** trace data out to the collector.
* **How it is configured so data reaches it:**  
  1. The OpenTelemetry SDK running inside the Node.js process captures each unit of work (a "span") and holds it in an in-memory buffer.
  2. Periodically (every few seconds or on flush), the SDK opens an HTTP connection and sends a `POST` request containing the spans to the Jaeger collector using the standard **OTLP** (OpenTelemetry Protocol).
  3. **The Configuration:** In Kubernetes deployment YAMLs, we tell the SDK where Jaeger is listening using an environment variable:
     ```yaml
     - name: OTEL_EXPORTER_OTLP_ENDPOINT
       value: "http://jaeger-srv:4318/v1/traces"
     ```
  4. Jaeger’s collector pod has an OTLP receiver listening on port `4318`. When it receives the HTTP payload, it parses the spans, indexes them by `trace_id`, and makes them searchable in the Jaeger UI (port `16686`).

---

#### 3. Prometheus (Metrics Collection & Storage)
* **What it is:**  
  An open-source systems monitoring and alerting toolkit (originally created by SoundCloud, now a foundational CNCF project). It is a purpose-built Time-Series Database (TSDB) engineered to store numerical measurements tagged with key-value labels and evaluate real-time aggregate queries and alerts using PromQL.
* **What it is used for:**  
  Storing aggregate numerical counters and gauges over time (e.g., requests per second, error rates, p95/p99 latency histograms, outbox queue size).
* **Data Delivery Model: PULL Model (Periodic Scraping)**  
  Unlike tracing, microservices **do not push** metrics to Prometheus. Instead, Prometheus **pulls (scrapes)** them on a timer.
* **How it is configured so data reaches it:**  
  1. The Node.js app maintains counters in memory and exposes a raw text endpoint: `GET /metrics`.
  2. How does Prometheus know where your pods are? **Kubernetes Service Discovery**.  
     Prometheus continuously queries the Kubernetes API Server to discover running pods.
  3. **The Configuration:** We put special annotations on the pod metadata in Kubernetes deployment manifests:
     ```yaml
     annotations:
       prometheus.io/scrape: "true"
       prometheus.io/port: "3000"
       prometheus.io/path: "/metrics"
     ```
  4. Every 5 seconds, Prometheus looks at all pods with `prometheus.io/scrape: "true"`, sends an HTTP GET request to `http://<pod-ip>:3000/metrics`, reads the numbers, and appends them to its Time-Series Database (TSDB).

---

#### 4. Kafka Exporter (Kafka Pipeline Metrics)
* **What it is:**  
  A specialized metrics bridge agent (an open-source Go daemon) that connects directly to an Apache Kafka cluster. It reads internal Kafka broker metadata, partition offset watermarks, and consumer group commit positions, converting them into standard Prometheus metrics.
* **What it is used for:**  
  Measuring consumer group lag (how many messages are sitting in Kafka waiting to be processed).
* **Data Delivery Model: PULL Bridge**  
  Kafka itself does not natively expose Prometheus-formatted `/metrics`.
* **How it is configured so data reaches it:**  
  1. We deploy a standalone `kafka-exporter` pod configured with the Kafka address: `--kafka.server=kafka-0.kafka-srv:9092`.
  2. It connects to the Kafka broker, reads partition offsets, and converts them into Prometheus metric format on port `9308`.
  3. Prometheus scrapes `kafka-exporter:9308/metrics` just like any other pod.

---

#### 5. Grafana (Dashboard Visualization)
* **What it is:**  
  The industry-standard open-source data visualization and analytics platform. It acts as a unified "single pane of glass" that connects to multiple backend databases (Prometheus, Loki, Elasticsearch, PostgreSQL) to turn raw numbers and logs into interactive charts, gauges, heatmaps, and alerting dashboards.
* **What it is used for:**  
  Rendering human-friendly dashboards, charts, gauges, and alert banners.
* **Data Delivery Model: Query-On-Demand (PromQL)**  
  Grafana **does not store any metric data**. It is purely a visualization layer.
* **How it is configured so data reaches it:**  
  1. Grafana is configured with a **Datasource** pointing to Prometheus: `http://prometheus-srv:9090`.
  2. When you open a dashboard in your browser, Grafana fires HTTP queries to Prometheus using PromQL (e.g., `sum(rate(ticketing_http_requests_total[1m])) by (service)`).
  3. Prometheus calculates the numbers and returns them to Grafana, which renders the line graphs in real time.

---

### Summary Table for Quick Revision:

| Tool | Pillar | Data Movement | How Connection is Made |
| :--- | :--- | :--- | :--- |
| **Pino** | Logs | Process ➔ `stdout` | OS / Container runtime captures stdout to `/var/log/pods`. |
| **Jaeger** | Traces | Pod **PUSHES** to Collector | `OTEL_EXPORTER_OTLP_ENDPOINT="http://jaeger-srv:4318/v1/traces"` |
| **Prometheus**| Metrics | Prometheus **PULLS** from Pod | Pod Annotations: `prometheus.io/scrape: "true"` |
| **Grafana** | Dashboards | Grafana **QUERIES** Prometheus | Configured Datasource: `http://prometheus-srv:9090` |

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
5. **Incident Triage & Troubleshooting Playbook:** See [06 — Production Incident Triage & Troubleshooting Playbook](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/fixes/notes/06-observability-triage-playbook.md) for a scenario-by-scenario cheat sheet on which tool to open first during production issues.

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


The 3 pillars of observability are Logs, Metrics, and Traces. They help you understand what happened, how the system is performing, and where a problem occurred.

Let's use your Order Service → Kafka → Payment Service example.

## 1. The three pillars

Logs — What happened?

Individual records of events or errors.

Example: `Payment failed: insufficient balance`

Useful for investigating specific events and error details.

Metrics — How is the system performing?

Numeric measurements collected over time.

Example: `Payment failure rate = 12%`

Useful for dashboards, alerts, latency, traffic, and error rates.

Traces — Where did the request go?

A connected sequence of operations across services.

Example: `Order API → Kafka → Payment Service`

Useful for finding bottlenecks and understanding end-to-end request flow.

## 2. How does `trace_id` bind them together?

Imagine an order fails during payment. You want to investigate the failure.

The Order Service creates a trace with this ID:

`trace_id = abc123`

That identifier can be attached to related logs and trace spans.

Logs

`trace_id=abc123 payment failed`

Traces

`trace_id=abc123` connects the Order API, Kafka processing, and Payment Service spans.

Metrics

Show the overall payment failure rate and latency. They may not have an individual trace ID.

Here's the important distinction: `trace_id` directly connects related spans and can correlate logs with a trace, but it does not automatically bind all three pillars.

- Logs: Include `trace_id` and often `span_id` as structured fields so you can jump from a log to its trace.
- Traces: Use `trace_id` to group spans belonging to the same trace.
- Metrics: Usually aggregate many requests together. They typically don't carry a unique `trace_id` because doing so would create excessive metric cardinality. Exemplars can link a metric measurement to a representative trace.

## 3. A real-world debugging workflow

Suppose customers report slow checkout.

1. Metrics: A dashboard shows that payment latency has increased.
2. Traces: You inspect a slow checkout trace and discover that the Payment Service took 3 seconds.
3. Logs: You open the logs associated with that trace ID and find a database timeout.

Now you know not just that the system is slow, but which service is responsible and what error occurred.

Interview-ready answer: The three pillars of observability are logs, metrics, and distributed traces. Logs describe individual events, metrics summarize system behavior, and traces show the end-to-end flow of operations. A `trace_id` correlates spans across services and can connect related logs to a trace. Metrics generally remain aggregated, with exemplars providing an optional link from a metric to a specific trace. Together, these signals make distributed systems easier to troubleshoot.



# Prometheus: High Cardinality and Time Series

## 1. What is a time series?

A **time series** is a set of values recorded over time.

Example: total HTTP requests each minute:

| Time | Total requests |
|---|---:|
| 10:00 | 100 |
| 10:01 | 150 |
| 10:02 | 230 |

In Prometheus, a time series is identified by the **metric name + all its label values**.

Example:
```text
http_requests_total{method="GET", route="/api/tickets/:id", status="200"}
```

If the metric name or any label value changes, it becomes a different time series.

- **Metric:** What you measure (e.g., HTTP requests).
- **Sample:** One value recorded at a particular time.
- **Time series:** Samples over time for one metric and label combination.
- **Cardinality:** The number of unique time series.

## 2. What is the high-cardinality problem?

Prometheus uses memory to manage time series. If labels contain values that keep changing, the number of time series can grow very large and use too much memory. In severe cases, Prometheus can run out of memory (OOM).

**Bad: use raw URLs or unique IDs as metric labels**
```text
http_requests_total{url="/api/tickets/101"}
http_requests_total{url="/api/tickets/102"}
http_requests_total{url="/api/tickets/103"}
```

Each URL can create a separate time series.

**Good: use a normalized route template**
```text
http_requests_total{route="/api/tickets/:id"}
```

Requests for ticket 101, 102, and 103 can share the same series if their other labels are identical.

## 3. How to prevent it

- Use route templates such as `/api/tickets/:id`, not raw URLs.
- Avoid labels such as `userId`, `orderId`, email, or query strings because they can have many unique values.
- Prefer bounded labels such as HTTP method, route template, and status code.
- Put request-specific details in logs or traces instead of metric labels.

In Express, `req.route.path` can provide the route template after a route has matched. Ensure metrics are recorded when route metadata is available; unmatched requests need a safe, bounded label such as `unmatched`.

## Interview answer

A time series is a sequence of timestamped metric values identified by a metric name and its complete set of labels. High cardinality happens when labels have too many unique combinations—for example, using raw URLs or user IDs. This can consume Prometheus memory and cause OOM errors. Use normalized route templates and bounded labels, and keep individual request details in logs or traces.
