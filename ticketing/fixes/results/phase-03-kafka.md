# Phase 03 Verification Results: Apache Kafka Migration & Dead Letter Queue

## 1. Executive Summary

Phase 03 successfully migrated the entire ticketing microservices event-driven infrastructure from deprecated NATS Streaming (STAN) to **Apache Kafka (v3.9.0)** running natively in **KRaft mode**:
- **Topic Architecture:** 4 primary topics (`ticket-events`, `order-events`, `payment-events`, `expiration-events`) and 4 quarantine topics (`*.dlq`), each provisioned with **3 partitions** to enable horizontal scaling across up to 3 worker pods per service.
- **Partition Key Guarantee:** All `order-events` are strictly keyed by **`ticket.id`**, ensuring that order creation, reservation, and cancellation events for a single ticket always land in the same partition and are consumed in strictly chronological order.
- **Producer Idempotence:** Producers configured with `idempotent: true` and `maxInFlightRequests: 1` to eliminate broker-level duplicate writes caused by network retry timeouts.
- **Consumer Reliability & DLQ Routing:** Centralized `EventConsumer` handles in-process blocking retries (attempts 1, 2, 3 with exponential backoff and consumer group heartbeats) and isolates poison pills / unparseable JSON directly to `<topic>.dlq` without halting the partition.
- **Legacy Removal:** Deprecated NATS Streaming deployment (`nats-depl.yaml` and `nats-srv`) completely removed from Kubernetes.

---

## 2. Load Testing Verification Results

### 2.1 End-to-End Purchase Flow Benchmark (`load-tests/scenarios/purchase-flow.js`)

**Target:** Sustained concurrent user purchase flows (signup → create ticket → create order → pay via Stripe).

```text
  █ THRESHOLDS 

    http_req_failed
    ✓ 'rate<0.05' rate=0.00%

    step_pay_order_duration
    ✓ 'p(95)<2500' p(95)=1232.5


  █ TOTAL RESULTS 

    checks_total.......: 1290    16.795826/s
    checks_succeeded...: 100.00% 1290 out of 1290
    checks_failed......: 0.00%   0 out of 1290

    ✓ signup succeeded (201)
    ✓ ticket created (201)
    ✓ order created (201)
    ✓ payment succeeded (201)

    CUSTOM
    completed_purchase_flows.......: 258    3.359165/s
    http_req_failed................: 0.00%  0 out of 1290
    http_reqs......................: 1290   16.795826/s
```

#### Outcome:
- **Completed Purchase Flows:** **258**
- **Failed Flows:** **0**
- **Total HTTP Requests:** **1,290**
- **Error Rate:** **0.00%** (100% checks passed)

---

### 2.2 Flash-Sale Race Condition (`load-tests/scenarios/flash-sale-race.js`)

**Target:** 1 ticket, 50 pre-registered buyers firing batch orders simultaneously through Kafka event bus.

- **Orders Created (201):** Exactly **1**
- **Orders Rejected (400):** Exactly **49**
- **Oversold Tickets:** **0**
- **Checks Succeeded:** **100.00%** (101 out of 101)

---

### 2.3 Double-Payment Concurrency (`load-tests/scenarios/double-payment.js`)

**Target:** 1 order, 10 simultaneous payments fired in parallel.

- **Payments Created (201):** Exactly **1**
- **Payments Rejected (400):** Exactly **9**
- **Duplicate Charges:** **0**
- **Checks Succeeded:** **100.00%** (12 out of 12)

---

## 3. Kafka Infrastructure Verification

### 3.1 Topic List Verification (`kafka-topics.sh --list`)
```text
expiration-events
expiration-events.dlq
order-events
order-events.dlq
payment-events
payment-events.dlq
ticket-events
ticket-events.dlq
```

### 3.2 Partition Key Integrity (`order-events`)
Verified via `kafka-console-consumer.sh --property print.key=true`:
```text
6ad08eecd60ff924e50fd3e2    {"id":"6ad08eede242d046475e20e3", ... "ticket":{"id":"6ad08eecd60ff924e50fd3e2"}}
```
Every order event is deterministically partitioned by `ticket.id`.

### 3.3 Consumer Group Rebalance & Horizontal Scale
Scaled `orders-depl` to 3 replicas and inspected consumer group partition assignments:
- **Pod 1:** Partition 0 across `ticket-events`, `expiration-events`, `payment-events`
- **Pod 2:** Partition 1 across `ticket-events`, `expiration-events`, `payment-events`
- **Pod 3:** Partition 2 across `ticket-events`, `expiration-events`, `payment-events`
- **Lag:** 0 across all partitions.

### 3.4 Poison Pill Isolation & DLQ Routing
Injected an unparseable malformed payload to `ticket-events`:
- The `EventConsumer` intercepted the JSON parse error.
- Successfully routed the message to `ticket-events.dlq` with diagnostic headers:
  - `event-type: ticket:created`
  - `dlq-error: JSON parse error: Unexpected token 'b', "bad-json-payload" is not valid JSON`
  - `dlq-consumer-group: orders-service`
  - `dlq-original-topic: ticket-events`
  - `dlq-failed-at: 2026-10-15T08:33:01.745Z`
- Committed the offset on `ticket-events` to ensure no head-of-line blocking occurred.

---

## 4. Test Suite Summary

All unit and integration test suites passing across all services:
- **tickets:** 7 suites passed / 23 tests passed
- **orders:** 7 suites passed / 20 tests passed
- **payments:** 3 suites passed / 10 tests passed
- **auth:** 4 suites passed / 12 tests passed
