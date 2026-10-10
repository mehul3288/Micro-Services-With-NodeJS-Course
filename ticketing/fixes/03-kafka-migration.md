# Phase 03 — Kafka Migration (with Retry & Dead Letter Queue)

**Goal:** Replace the deprecated NATS Streaming (STAN) with **Apache Kafka**, use partition keys to guarantee
per-ticket ordering, and make sure one bad message can never block or crash a service.

**Grouped because:** retry and DLQ behavior lives inside the new consumer code. Building them separately
would mean writing the consumer twice.

---

## 1. Why Kafka (and Why Now)

| Concern | STAN today | Kafka |
|---|---|---|
| Maintenance | **Deprecated** (end of life) | Industry standard, actively developed |
| Ordering | Per channel only, broken by queue groups + redelivery | **Per partition**, guaranteed by key |
| Replay | Limited | Rewind offsets to any point in time |
| Ecosystem | Small | Schema Registry (Phase 09), exporters (Phase 06), Connect/Debezium |
| Interview value | Low | Very high |

The existing [notes/kafka-vs-nats.md](../notes/kafka-vs-nats.md) already covers the theory. This phase applies it.

---

## 2. Topic Design — The Most Important Decision

### Problem: ordering across events of the same ticket
Today every subject is its own channel. `OrderCreated` and `OrderCancelled` can arrive in any order,
and that is why the `version` / `findByEvent` workaround exists.

Real failure scenario with separate channels:
```text
1. Order-1 for Ticket-X cancelled  → OrderCancelled(order-1)
2. Order-2 for Ticket-X created    → OrderCreated(order-2)
Tickets service receives them in REVERSE order:
   OrderCreated(order-2)   → ticket.orderId = order-2
   OrderCancelled(order-1) → ticket.orderId = undefined   ← Ticket-X is free while order-2 is active!
```

### Solution: one topic per aggregate, keyed by the entity whose rules we protect
| Topic | Events | Partition key | Why this key |
|---|---|---|---|
| `ticket-events` | TicketCreated, TicketUpdated | `ticket.id` | Ticket versions applied in order |
| `order-events` | OrderCreated, OrderCancelled | **`ticket.id`** | All reservations / releases of one ticket stay in order |
| `payment-events` | PaymentCreated | `orderId` | Per-order ordering |
| `expiration-events` | ExpirationComplete | `orderId` | Per-order ordering |

Kafka guarantees order **within a partition**, and the same key always goes to the same partition.
So every event that touches Ticket-X is processed in exactly the order it was produced.

`order-events` is keyed by **ticket id**, not order id. This is intentional, and a good interview question.

Each topic has **3 partitions**, so up to 3 consumer pods per service can work in parallel.
The `version` check stays as a safety net.

---

## 3. Message Format

The event **data stays exactly as defined today** in `common/src/events/*-event.ts`. Metadata goes in Kafka headers:

| Header | Example | Used for |
|---|---|---|
| `event-id` | `9b1d...` (UUID v4) | Idempotent consumers (Phase 04), DLQ replay |
| `event-type` | `order:created` | Routing to the right listener |
| `occurred-at` | ISO timestamp | Debugging, lag measurement |
| `traceparent` | W3C trace context | Distributed tracing (Phase 06) |

Keeping metadata out of the payload means Phase 09 (Schema Registry) only changes how the **value** is serialized.

---

## 4. Code Design

### What changes in common
```text
common/src/events/
├── subjects.ts             (unchanged)
├── topics.ts               NEW  — Topics enum + subject → topic map
├── base-publisher.ts       REWRITTEN for Kafka producer
├── base-listener.ts        REWRITTEN — just subject + onMessage, no transport code
├── event-consumer.ts       NEW  — one Kafka consumer per service: routing, retry, DLQ
└── *-event.ts              (unchanged)
```

### `base-publisher.ts`
```ts
export abstract class Publisher<T extends Event> {
    abstract subject: T["subject"];
    abstract partitionKey(data: T["data"]): string;
    protected producer: Producer;

    constructor(producer: Producer) {
        this.producer = producer;
    }

    async publish(data: T["data"]): Promise<void> {
        await this.producer.send({
            topic: topicFor[this.subject],
            messages: [{
                key: this.partitionKey(data),
                value: JSON.stringify(data),
                headers: {
                    "event-id": randomUUID(),
                    "event-type": this.subject,
                    "occurred-at": new Date().toISOString()
                }
            }]
        });
    }
}
```

A concrete publisher only gains one line:
```ts
export class OrderCreatedPublisher extends Publisher<OrderCreatedEvent> {
    readonly subject = Subjects.OrderCreated;
    partitionKey(data: OrderCreatedEvent["data"]) { return data.ticket.id; }
}
```

### `base-listener.ts`
```ts
export interface EventMetadata {
    eventId: string;
    occurredAt: string;
}

export abstract class Listener<T extends Event> {
    abstract subject: T["subject"];
    abstract onMessage(data: T["data"], metadata: EventMetadata): Promise<void>;
}
```
Listeners no longer call `msg.ack()`. If `onMessage` resolves, the offset is committed. If it throws, the retry policy applies.
`queueGroupName` moves to the consumer (Kafka calls it a **consumer group**).

### `event-consumer.ts`: routing, retry and DLQ in one readable place
```text
eachMessage(topic, message)
   │
   ├─ read "event-type" header → find the registered listener
   │      no listener? → skip (this service doesn't care about this event)
   │
   ├─ parse JSON  ── fails? ──────────────────────────► send to DLQ immediately (retrying won't help)
   │
   ├─ attempt 1 → onMessage()  ── ok ──► offset committed ✅
   │      fails → wait 1s, heartbeat()
   ├─ attempt 2 ── fails → wait 2s, heartbeat()
   ├─ attempt 3 ── fails
   │
   └─ send to "<topic>.dlq" with error headers ──► offset committed, partition moves on
```

```ts
const consumer = new EventConsumer(kafkaWrapper.kafka, "orders-service");
consumer.register(new TicketCreatedListener());
consumer.register(new TicketUpdatedListener());
consumer.register(new ExpirationCompleteListener());
consumer.register(new PaymentCreatedListener());
await consumer.start();
```
This replaces the four `new XListener(natsWrapper.client).listen()` lines in `index.ts`. It reads the same way as before.

### Retry design: blocking retries (chosen) vs retry topics
| | Blocking in-process retries (chosen) | Retry topics (`topic.retry-5s`, `topic.retry-1m`) |
|---|---|---|
| Ordering per key | **Preserved** | Broken: a retried event goes behind newer ones |
| Partition blocked during retry | Yes, ~7s max | No |
| Complexity | Low | High |

Ordering per ticket is the whole point of the topic design, so blocking retries are the correct trade-off.
Retry topics (Uber's pattern) are the answer when throughput matters more than ordering. Worth mentioning in an interview.

### DLQ message
Same key, value and headers as the original, plus:

| Header | Value |
|---|---|
| `dlq-error` | error message |
| `dlq-consumer-group` | e.g. `orders-service` |
| `dlq-original-topic` | e.g. `ticket-events` |
| `dlq-failed-at` | timestamp |

Replay tool: `tools/dlq-replay/` is a ~40-line script that reads a DLQ topic and republishes to the original topic.
Phase 04's idempotent consumers make replays safe. Phase 06 adds an alert on DLQ growth.

### Per-service `kafka-wrapper.ts` (replaces `nats-wrapper.ts`)
Same shape as the current `NatsWrapper` (private client, getter that throws if not connected, `connect()`),
so it stays familiar:

```ts
class KafkaWrapper {
    private _kafka?: Kafka;
    private _producer?: Producer;

    get producer() { /* throws if not connected, like today */ }
    get kafka() { /* same */ }

    async connect(clientId: string, brokers: string[]) {
        this._kafka = new Kafka({ clientId, brokers });
        this._producer = this._kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
        await this._producer.connect();
    }
}
```
`idempotent: true` makes the broker drop duplicate writes caused by producer retries.

### Topic creation
`common` exports `ensureTopics(kafka, topics)`, called at service startup (`admin.createTopics` is a no-op for
existing topics). DLQ topics are created at the same time. `auto.create.topics.enable` is **off** on the broker,
so a typo in a topic name fails loudly.

---

## 5. Other Fixes Bundled Here

- Tickets `OrderCancelledListener`: only clear `orderId` if `ticket.orderId === data.id` (defensive, mirrors `Ticket.release()` from Phase 02).
- Remove `natsWrapper.client.on("close", ...)` patterns. Shutdown is handled by `registerGracefulShutdown` (Phase 01), with closers `consumer.disconnect()` and `producer.disconnect()`.
- Readiness check: `kafkaWrapper.isConnected` replaces `natsWrapper.isConnected`.

---

## 6. Infrastructure

| File | Change |
|---|---|
| `infra/k8s/nats-depl.yaml` | **Deleted** |
| `infra/k8s/kafka-statefulset.yaml` | NEW: `apache/kafka:3.9.0`, single broker, **KRaft mode** (no ZooKeeper), PVC, headless `kafka-srv` |
| all service Deployments | `NATS_*` env vars → `KAFKA_BROKERS=kafka-0.kafka-srv:9092`, `KAFKA_CLIENT_ID` from pod name |
| `nats-tests/` | Left untouched as a learning artifact |

Key broker settings: `KAFKA_PROCESS_ROLES=broker,controller`, `KAFKA_AUTO_CREATE_TOPICS_ENABLE=false`,
replication factors = 1 (single broker, documented as a local-only setting).

---

## 7. Migration Steps (Order Matters)

```text
1. common: rewrite publisher/listener, add consumer + topics → npm version MAJOR (2.0.0) → publish
2. Deploy Kafka, verify with kafka-topics.sh --list
3. Service by service: kafka-wrapper, publishers (+ partitionKey), listeners (drop msg.ack), index.ts, mocks, tests
4. Delete NATS deployment
5. Run full test suite + load tests
```

In a real company you would run both brokers side by side with a bridge, or dual-publish during migration.
Here a clean cut-over is fine, but be ready to explain the zero-downtime version in an interview.

---

## 8. Tests

| Test | Where |
|---|---|
| Publisher sends to the right topic with the right key and headers | `common` unit test with a mocked producer |
| Consumer routes by `event-type` | `common` |
| Consumer retries 3 times then publishes to DLQ | `common` (fake timers) |
| Invalid JSON goes straight to DLQ | `common` |
| All existing listener tests updated (no `msg.ack`, assert promise resolves) | every service |
| `__mocks__/kafka-wrapper.ts` replaces `__mocks__/nats-wrapper.ts` | every service |

---

## 9. Verification

| Test | Expected |
|---|---|
| Full purchase flow works end-to-end | ✅ |
| `kafka-console-consumer --topic order-events --property print.key=true` | keys are ticket ids |
| Publish a malformed message to `ticket-events` | lands in `ticket-events.dlq`, orders service keeps processing |
| Make a listener throw for one ticket id | 3 attempts in logs → DLQ → next messages processed |
| Scale orders to 3 replicas | partitions spread across pods (`kafka-consumer-groups --describe`) |
| Re-run `purchase-flow.js` | throughput ≥ Phase 02 baseline |

Record in `results/phase-03-kafka.md`.

---

## 10. Interview Angle

- **Partition key selection**: "key by the entity whose invariants you protect". Why `order-events` is keyed by ticket id.
- **Consumer groups** and how partitions are rebalanced when pods are added or removed.
- **At-least-once** delivery: offsets are committed after processing. Duplicates are possible, so Phase 04 handles them.
- **Poison pills**, why they block a partition, and how a DLQ fixes that.
- **Blocking retries vs retry topics**: ordering vs throughput.
- **Idempotent producer**: what it protects against (producer retries), and what it doesn't (application-level duplicates).
- **KRaft** vs ZooKeeper.

---

## 11. Checklist

- [ ] Concept lesson written in `fixes/lessons/03-kafka-and-event-streaming.md`, taught & discussed in detail, and explicit go-ahead signal received from developer
- [ ] common 2.0.0: Kafka publisher, listener, consumer, topics, `ensureTopics`
- [ ] Kafka StatefulSet (KRaft) running, NATS removed
- [ ] All services migrated (wrapper, publishers with partition keys, listeners, index.ts, mocks)
- [ ] Defensive check in tickets `OrderCancelledListener`
- [ ] DLQ working + `tools/dlq-replay` script
- [ ] All tests updated and passing
- [ ] Verification table complete, results recorded
- [ ] `notes/03-kafka-partitioning-and-dlq.md` written
