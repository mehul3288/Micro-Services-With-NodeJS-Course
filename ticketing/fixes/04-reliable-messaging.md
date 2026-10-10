# Phase 04 — Reliable Messaging (Transactional Outbox + Idempotent Consumers)

**Goal:** Every database change that should produce an event **always** produces it, exactly once in effect,
even when pods crash at the worst possible moment.

**Grouped because:** the outbox guarantees **at-least-once** publishing, which means duplicates *will* happen.
Idempotent consumers are what turn at-least-once into **effectively-once**. One half is useless without the other.

**Depends on:** Phase 01 (replica set → transactions), Phase 03 (Kafka producer, `event-id` header).

---

## 1. The Dual-Write Problem

Every route and listener that changes data and publishes an event has this shape today
([orders/src/routes/new.ts](../orders/src/routes/new.ts) lines 42–56):

```text
   await order.save();          ✅ written to Mongo
   ─────── pod crashes / Kafka unreachable / network blip ───────
   await publisher.publish();   ❌ never happens
```

Result: the order exists, but **tickets never marks the ticket reserved**, **expiration never schedules a
timeout**, and **payments never learns the order exists**. The system is permanently inconsistent, and no
error is shown anywhere. The Phase 00 chaos test measures exactly this.

Swapping the order (publish first, then save) has the opposite problem: an event for an order that doesn't exist.

---

## 2. The Solution: Transactional Outbox

```text
  ┌──────────────── ONE Mongo transaction ────────────────┐
  │  orders collection:  insert Order                     │
  │  outbox collection:  insert { topic, key, payload }   │   ← both commit, or neither does
  └───────────────────────────────────────────────────────┘
                              │
                              ▼
           OutboxRelay (background loop in the same service)
           1. read unpublished rows, oldest first
           2. producer.send() to Kafka
           3. mark row as published
                              │
                              ▼
                          Kafka topic
```

The business write and the "intent to publish" are committed **atomically**. If the pod crashes after the commit,
the relay picks the row up when it restarts. Nothing is ever lost.

### Relay options considered
| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Polling relay** (chosen) | Simple, easy to read and debug, no extra infrastructure | ~100ms average extra latency, small DB load | ✅ Right size for this project |
| Mongo Change Streams | Push-based, low latency | Resume-token handling, harder to test | Mention as an upgrade path |
| Debezium (CDC) + Kafka Connect | Industry standard at scale, no app code | Heavy (Kafka Connect cluster), lots of operations work | Mention in interview |

---

## 3. Code Design

### New in common (mongoose becomes a **peerDependency**)
```text
common/src/outbox/
├── outbox-event.ts       Mongoose model for the outbox collection
├── outbox-publisher.ts   Base class: same subject/partitionKey API, but writes to the outbox
├── outbox-relay.ts       Background loop: outbox → Kafka
└── lease.ts              Tiny leader election so only one replica runs the relay
common/src/events/
└── processed-event.ts    Mongoose model for consumer deduplication
```

> **Gotcha: why a peerDependency?** If common bundles its own copy of mongoose, models defined in common
> register on a **different, never-connected** mongoose instance, and every query hangs. With a
> `peerDependency`, npm resolves to the service's single mongoose instance.

### `outbox-event.ts` (model)
| Field | Type | Notes |
|---|---|---|
| `eventId` | string (UUID) | unique, becomes the `event-id` header |
| `topic`, `key`, `eventType` | string | where and how to publish |
| `payload` | string | JSON of the event data |
| `headers` | map | e.g. `traceparent` (used in Phase 06) |
| `publishedAt` | Date \| null | `null` = pending |

Indexes: `{ publishedAt: 1, _id: 1 }` for the relay query, and a TTL index that deletes published rows after 7 days.

### `OutboxPublisher`: the call site barely changes
```ts
export class OrderCreatedPublisher extends OutboxPublisher<OrderCreatedEvent> {
    readonly subject = Subjects.OrderCreated;
    partitionKey(data: OrderCreatedEvent["data"]) { return data.ticket.id; }
}
```

### Route after the change — `orders/src/routes/new.ts`
```ts
await mongoose.connection.transaction(async (session) => {
    const reservedTicket = await Ticket.reserve(ticket.id, order.id, session);
    if (!reservedTicket) {
        throw new BadRequestError("Ticket is already reserved");
    }

    await order.save({ session });

    await new OrderCreatedPublisher().publish({
        id: order.id,
        status: order.status,
        userId: order.userId,
        expiresAt: order.expiresAt.toISOString(),
        version: order.version,
        ticket: { id: ticket.id, price: ticket.price }
    }, session);
});

res.status(201).send(order);
```
This also closes the Phase 02 gap: **reserve + order + event** now commit together.
`mongoose.connection.transaction()` retries automatically on transient transaction errors.

### `OutboxRelay`
```text
every 200ms:
   am I the leader? (lease)  ── no ──► skip
   rows = find({ publishedAt: null }).sort({ _id: 1 }).limit(100)
   for each row, IN ORDER:
       producer.send(row)                       ← idempotent producer from Phase 03
       updateOne({ _id }, { publishedAt: now })
```

- **Sequential, oldest first**: preserves per-key ordering.
- **Crash between send and mark**: the row is sent again → duplicate in Kafka → handled by idempotent consumers.
  This is why the outbox is *at-least-once*.
- **Leader lease** (`lease.ts`): a single Mongo document `{ _id: "outbox-relay", holder, expiresAt }` claimed with an
  atomic `findOneAndUpdate`. With 3 replicas, only one publishes, so events are not reordered.
  If the leader dies, the lease expires after 10s and another replica takes over.

Started in `index.ts` next to the consumer:
```ts
new OutboxRelay(kafkaWrapper.producer).start();
```

### What about the expiration service?
It has no Mongo, and it doesn't need an outbox: the **Bull job is the outbox**. The job is persisted in Redis
(AOF, Phase 01), and if publishing fails the job is retried (Phase 02). It keeps using the direct `Publisher` from Phase 03.

### What about payments and Stripe?
A Stripe call can't be part of a Mongo transaction. The order of operations is:
```text
1. stripe.charges.create(..., { idempotencyKey: `charge-${orderId}` })     ← external
2. transaction { payment.save(); PaymentCreatedPublisher.publish() }      ← atomic
```
If the pod crashes between 1 and 2 and the client retries, Stripe returns the **same** charge (Phase 02 key),
and step 2 completes. Phase 05 adds reconciliation for the case where the client never retries.

---

## 4. Idempotent Consumers

### Why duplicates happen (even with everything above)
| Cause | Example |
|---|---|
| Relay crash between send and mark | Same outbox row published twice |
| Consumer crash after DB write, before offset commit | Kafka redelivers |
| Consumer group rebalance | Uncommitted messages are redelivered to the new owner |
| DLQ replay | Operator replays messages that partly succeeded |

### The fix: record processed event ids **in the same transaction** as the business change
```text
  ┌──────────────── ONE Mongo transaction ─────────────────────────┐
  │  processedevents:  insert { eventId, consumerGroup }  (unique) │
  │  business change:  e.g. ticket.save(), outbox insert           │
  └────────────────────────────────────────────────────────────────┘
  duplicate eventId → unique index violation → transaction aborted → log "duplicate skipped" → commit offset
```

Recording the id **in the same transaction** is the key point. Recording it before or after the business change
leaves a crash window where the event is either lost or applied twice.

### Code: one option on the consumer, listeners get a session
```ts
const consumer = new EventConsumer(kafkaWrapper.kafka, "tickets-service", { deduplicate: true });
```

```ts
export class OrderCreatedListener extends Listener<OrderCreatedEvent> {
    readonly subject = Subjects.OrderCreated;

    async onMessage(data: OrderCreatedEvent["data"], { session }: EventMetadata) {
        const ticket = await Ticket.findById(data.ticket.id).session(session);
        if (!ticket) {
            throw new Error("Ticket not found");
        }

        ticket.set({ orderId: data.id });
        await ticket.save({ session });

        await new TicketUpdatedPublisher().publish({ ...ticketData }, session);
    }
}
```
The listener reads like today. The only new things are `session` and the outbox-backed publisher.

### Dedup window
`processedevents` has a TTL of **7 days**, the same as the Kafka topic retention.
An event older than the retention can't be redelivered, so remembering it longer would be wasted storage.

---

## 5. Test Setup Change

Transactions need a replica set in tests too. In every service's `src/test/setup.ts`:
```ts
mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
```

Tests become **more meaningful**: instead of asserting `publish` was called on a mock,
we assert an `OutboxEvent` document with the right topic, key and payload exists.

| Test | Where |
|---|---|
| Creating an order writes Order + OutboxEvent; a failure rolls back both | `orders/src/routes/__test__/new.test.ts` |
| Relay publishes pending rows in order and marks them published | `common` |
| Relay does nothing when it doesn't hold the lease | `common` |
| Same event delivered twice → business change applied once | each listener test |
| Listener throws → `processedevents` row also rolled back (event retried) | `common` |

---

## 6. Verification

| Test | How | Phase 00 | Expected |
|---|---|---|---|
| Crash during writes | `purchase-flow.js` + `kubectl delete pod -l app=orders` every 20s → `consistency.ps1` | mismatches > 0 | **0 mismatches** |
| Kafka down | Scale Kafka to 0 for 60s during load, then back | requests fail | Requests **succeed**; events queue in outbox and drain after Kafka returns |
| Duplicate delivery | Replay a batch of `order-events` with `tools/dlq-replay` | double effects | "duplicate skipped" logs, **no double effects** |
| Relay failover | 2 orders replicas, kill the lease holder | n/a | Other replica takes over within ~10s |
| Added latency | Event propagation time (outbox insert → consumer) | n/a | Record p50 / p95 |

"Kafka down but users can still buy tickets" is one of the strongest demos in the project.

Record in `results/phase-04-reliable-messaging.md`.

---

## 7. Interview Angle

- **Dual-write problem**, and why neither order (save→publish or publish→save) works.
- **Outbox pattern**: polling vs change streams vs CDC (Debezium), and when you'd move up.
- **At-least-once + idempotency = effectively-once.** Why true exactly-once across systems is a myth outside a single system (Kafka transactions only cover Kafka→Kafka).
- **Why the dedup record must be in the same transaction** as the business change.
- **Leader election with a lease**: what happens on a network partition (two leaders briefly → duplicates → handled by idempotency).
- **Dedup window = retention window.**
- **Graceful degradation**: the write path no longer depends on Kafka being up.

---

## 8. Checklist

- [ ] Concept lesson written in `fixes/lessons/04-transactional-outbox-and-idempotency.md`, taught & discussed in detail, and explicit go-ahead signal received from developer
- [ ] common: OutboxEvent, OutboxPublisher, OutboxRelay, Lease, ProcessedEvent; mongoose as peerDependency
- [ ] `EventConsumer` `deduplicate` option with transaction + session in metadata
- [ ] Orders: new / delete routes + listeners use transactions + outbox
- [ ] Tickets: new / update routes + listeners use transactions + outbox
- [ ] Payments: route (Stripe → transaction) + listeners
- [ ] Expiration unchanged (Bull job is its outbox) — documented
- [ ] All test setups use `MongoMemoryReplSet`, tests assert outbox rows
- [ ] Chaos, Kafka-down and duplicate tests pass; results recorded
- [ ] `notes/04-outbox-and-idempotency.md` written
