# Phase 04 Concept Lesson: Reliable Messaging (Transactional Outbox & Idempotent Consumers)

> **Phase Goal:** Ensure that every database change that should produce an event **always** produces it, and every consumed event is applied **exactly once in effect**, even if Kubernetes pods crash, network connections drop, or the Kafka broker temporarily blips.

---

## 1. The Big Picture: Why Reliable Messaging Matters

In a distributed microservices architecture, services communicate by publishing and consuming events over a message broker (Apache Kafka). 

However, microservices have two separate worlds:
1. **Their local database** (MongoDB), which holds their internal state.
2. **The message broker** (Apache Kafka), which notifies the rest of the world about state changes.

When a user performs an action (e.g. buying a ticket), the service must do **two things**:
1. Save the order to MongoDB.
2. Publish an `OrderCreated` event to Kafka.

These two actions cannot be wrapped in a single database transaction because MongoDB and Kafka are completely separate systems running on different servers. 

If a pod crashes or loses network connectivity between step 1 and step 2, the system ends up in an **inconsistent, corrupted state**:
- The order exists in MongoDB.
- But the event is never sent to Kafka!
- `tickets` never locks the ticket, `expiration` never starts the 15-minute countdown, and `payments` has no idea the order exists.

**Phase 04 introduces two industry-standard patterns to solve this permanently:**
1. **The Transactional Outbox Pattern:** Guarantees **at-least-once publishing** (no event is ever lost).
2. **Idempotent Consumers:** Turns *at-least-once* publishing into **effectively-once processing** (no event is ever processed twice).

---

## 2. The Problem Today: The Dual-Write Vulnerability

### Scenario A: Save to DB First, Then Publish (Our Code Today)

Look at how [orders/src/routes/new.ts](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/orders/src/routes/new.ts) operates:

```ts
// ❌ TODAY'S PATTERN: Non-atomic dual write
const order = Order.build({ ... });
await order.save(); // Step 1: MongoDB write succeeds ✅

// ⚡ CRASH WINDOW:
// Pod gets OOMKilled, node restarts, Kafka network drops, or process exits here!

await new OrderCreatedPublisher(kafkaWrapper.producer).publish({ ... }); // Step 2: NEVER RUNS! ❌
```

**The Disaster:**
- The customer's order is in MongoDB.
- Kafka never received `OrderCreated`.
- `tickets` never locked the ticket (`orderId` remains `undefined`), so another buyer can purchase it!
- `expiration` never scheduled the timeout job.
- The order is permanently orphaned with zero error messages.

---

### Scenario B: Publish First, Then Save to DB?

What if we reverse the order?

```ts
// ❌ REVERSED PATTERN: Even worse!
await new OrderCreatedPublisher(kafkaWrapper.producer).publish({ ... }); // Step 1: Kafka message sent ✅

// ⚡ CRASH WINDOW: MongoDB disk full, connection dropped, or validation error!

await order.save(); // Step 2: THROWS ERROR OR CRASHES! ❌
```

**The Disaster:**
- Other services (`tickets`, `payments`, `expiration`) receive an event for an order that **does not exist in the orders database**! 
- The customer gets an HTTP 500 error, but their ticket is locked by `tickets` service forever.

---

### Scenario C: Consumer Crashes After Database Write, Before Offset Commit

Now look at the consumer side. When a message is consumed from Kafka:

```text
Kafka delivers Msg ──► Listener executes DB write ──► Consumer commits Kafka offset
                                 │                                 │
                                 ▼                                 ▼
                              Succeeded!                    ⚡ Pod crashes here!
```

If the pod crashes before Kafka receives the offset commit:
1. Kubernetes restarts the pod.
2. Kafka notices the offset was never committed, so it **redelivers the exact same message**.
3. The listener runs a second time and modifies the database again (e.g. creating a duplicate record or double charging).

This is why **at-least-once delivery requires idempotent consumers**.

---

## 3. Core Concepts Explained

### 3.1 The Transactional Outbox Pattern

Instead of publishing directly to Kafka in the HTTP request handler, we write the event into an **`outbox` collection in the same database**, inside the **same MongoDB transaction** as the business data:

```text
┌────────────────────────── ONE MONGO TRANSACTION ──────────────────────────┐
│                                                                           │
│   1. orders collection: insert Order document                             │
│   2. outbox collection: insert OutboxEvent { topic, key, payload }        │
│                                                                           │
│   ──► ATOMIC: Both commit together, or both roll back together!           │
└─────────────────────────────────────┬─────────────────────────────────────┘
                                      │
                                      ▼ (Committed to Mongo)
                    ┌───────────────────────────────────┐
                    │            OutboxRelay            │
                    │   (Background loop in service)    │
                    │                                   │
                    │   1. Read pending events          │
                    │   2. Send to Kafka broker         │
                    │   3. Mark publishedAt = now       │
                    └─────────────────┬─────────────────┘
                                      │
                                      ▼
                             Apache Kafka Topic
```

Because MongoDB (since Phase 01's replica set migration) supports ACID multi-document transactions:
- If the pod crashes before the transaction commits, **neither** the order nor the outbox event exists. Safe!
- If the pod crashes after the transaction commits, **both** exist in MongoDB.
- When the pod restarts, the **`OutboxRelay`** reads the pending outbox event from MongoDB and publishes it to Kafka. **Nothing is ever lost!**

---

### 3.2 The Outbox Relay (Polling Worker)

The `OutboxRelay` is a lightweight background worker running inside the service:
1. Every 200ms, it queries MongoDB:
   ```ts
   OutboxEvent.find({ publishedAt: null }).sort({ _id: 1 }).limit(100);
   ```
2. For each pending event (in exact chronological order):
   - Sends it to Kafka using `kafkaWrapper.producer.send()`.
   - Once Kafka acknowledges the write, updates the document: `{ publishedAt: new Date() }`.
3. An automated MongoDB TTL (Time-To-Live) index automatically purges published outbox records after 7 days to keep the database lean.

---

### 3.3 Distributed Leader Lease (Why Multiple Pods Don't Collide)

In Kubernetes, we often have 2 or 3 replicas of the `orders` service running.
If all 3 pods poll the outbox collection simultaneously:
- They might read the same pending events and publish them concurrently, causing duplicate Kafka messages or racing each other.

To prevent this, we use a **Leader Lease** (`lease.ts`):
- A single document in MongoDB: `{ _id: "outbox-relay-lease", holder: "orders-depl-pod-1", expiresAt: "2026-10-15T10:00:10Z" }`.
- Every 5 seconds, each pod tries to acquire or renew the lease using an atomic `findOneAndUpdate`.
- **Only the pod holding the valid lease runs the outbox publishing loop.**
- If the leader pod crashes, its lease expires after 10 seconds, and another pod seamlessly takes over.

---

### 3.4 Idempotent Consumers (Deduplication)

Because network failures or pod restarts between Kafka publish and outbox mark can result in duplicate messages in Kafka (*at-least-once* delivery), the receiving service must be **idempotent**.

**How it works:**
1. Every event published via Outbox contains a unique `event-id` (UUID v4) in its Kafka headers.
2. The receiving service maintains a `processedevents` collection with a unique compound index:
   ```ts
   { eventId: 1, consumerGroup: 1 } // UNIQUE
   ```
3. When `EventConsumer` receives an event, it executes the listener and records the `eventId` in the **same MongoDB transaction**:
   ```text
   ┌─────────────────────── ONE MONGO TRANSACTION ───────────────────────┐
   │                                                                     │
   │  1. Insert into processedevents: { eventId: "uuid-1", group: "..." }│
   │  2. Apply business logic: ticket.save()                             │
   │                                                                     │
   └─────────────────────────────────────────────────────────────────────┘
   ```
4. If a duplicate event arrives:
   - MongoDB throws a **Duplicate Key Error (code 11000)** on the unique index.
   - The transaction aborts immediately (zero side effects on the database!).
   - `EventConsumer` catches the error, logs `"Duplicate event skipped"`, and commits the Kafka offset!

---

## 4. How It Applies to Our Services

| Service | Uses Outbox? | Uses Idempotent Consumer? | Special Handling |
|---|---|---|---|
| **`orders`** | **YES** | **YES** | Order creation atomically locks ticket, creates order, and writes Outbox event. |
| **`tickets`** | **YES** | **YES** | Ticket updates write to Outbox; listens to `order:*` with transaction session. |
| **`payments`** | **YES** | **YES** | Calls Stripe first (with idempotency key `charge-${orderId}`), then writes Payment + Outbox event atomically in MongoDB. |
| **`expiration`** | **NO** | **NO** | Has no MongoDB! Uses Redis + Bull. The persistent Bull queue in Redis *is* its outbox. |

---

## 5. Architectural Alternatives Considered

| Approach | How it works | Pros | Cons | Why we chose Polling Outbox |
|---|---|---|---|---|
| **Two-Phase Commit (2PC / XA)** | Distributed coordinator locks both DB and Kafka. | Atomic across systems. | Extremely slow, blocking, high failure rate, unsupported in modern microservices. | ❌ Rejected |
| **MongoDB Change Streams** | Mongo oplog streams changes via Node.js events. | Lower latency (~10ms). | Requires complex resume token state management, fragile on cluster reconnections, hard to mock in Jest. | ⚠️ Good upgrade path, but complex for tests |
| **Debezium CDC + Kafka Connect** | Dedicated cluster reading MongoDB oplog and publishing directly to Kafka. | Zero application code. | Heavy infrastructure (requires a separate Kafka Connect cluster and Debezium connector). | ⚠️ Enterprise standard at huge scale, but too heavy for local Kubernetes |
| **Transactional Outbox with Polling Relay (Chosen)** | Insert outbox event in same Mongo transaction; background worker polls and publishes. | **Simple, 100% reliable, zero extra infrastructure, testable with MongoMemoryServer, full audit trail.** | ~100–200ms latency between DB commit and Kafka publish. | ✅ **Best engineering trade-off** |

---

## 6. What Will Change in the Codebase

### 1. In `@mehul-mrtickets/common`:
- `mongoose` becomes a `peerDependency` (prevents duplicate Mongoose instance bugs where models register on an unconnected instance).
- `common/src/outbox/outbox-event.ts`: Model for pending events.
- `common/src/outbox/outbox-publisher.ts`: Base publisher writing to outbox in a Mongo session.
- `common/src/outbox/outbox-relay.ts`: The background polling worker.
- `common/src/outbox/lease.ts`: Leader election for multi-replica outbox relays.
- `common/src/events/processed-event.ts`: Deduplication collection model.
- `common/src/events/event-consumer.ts`: Updated to support automatic deduplication transactions.

### 2. In Microservices (`orders`, `tickets`, `payments`):
- Endpoints use `mongoose.connection.transaction(async (session) => { ... })`.
- Handlers pass `session` to OutboxPublishers.
- `index.ts` starts the `OutboxRelay`.

---

## 7. Architectural Glossary

- **Dual Write:** The anti-pattern of attempting to write to two independent storage systems (e.g. Database and Message Broker) sequentially without a distributed consensus protocol.
- **Transactional Outbox:** An architectural pattern where outgoing messages are saved directly into an outbox table in the same database transaction as business entities.
- **Outbox Relay:** A background process that reads unpublished records from the outbox table and delivers them to the message broker.
- **Distributed Lease:** A time-bound lock stored in a shared database that ensures only one node acts as the leader at any given time.
- **At-Least-Once Delivery:** A delivery guarantee where messages are never lost, but may occasionally be delivered more than once due to retries or network blips.
- **Effectively-Once Processing:** The combination of *at-least-once delivery* and an *idempotent consumer* that guarantees the end state is identical to processing each message exactly once.
- **Idempotency Key:** A unique identifier attached to an operation or event that allows the receiver to detect and discard duplicate requests.

---

## 8. Self-Check Questions: Verify Your Understanding

Before we start building, test your mental model with these questions:

<details>
<summary><b>1. Why can't we simply put <code>await publisher.publish()</code> inside the MongoDB transaction block?</b></summary>
Because Kafka is NOT part of MongoDB! If MongoDB commits the transaction, but Kafka is unreachable, the event is lost. Conversely, if Kafka accepts the event, but MongoDB aborts the transaction on commit, Kafka has an event for data that was never saved.
</details>

<details>
<summary><b>2. If the OutboxRelay crashes immediately after publishing to Kafka, but before marking the outbox row as published, what happens?</b></summary>
When the relay restarts, it sees the outbox row is still <code>publishedAt: null</code>, so it publishes it to Kafka a second time. This causes a duplicate message in Kafka. That is why an Outbox guarantees <b>at-least-once</b> publishing and MUST be paired with an <b>idempotent consumer</b>.
</details>

<details>
<summary><b>3. How does the idempotent consumer detect that a message is a duplicate?</b></summary>
Every event has a unique <code>event-id</code> header. The consumer tries to insert <code>{ eventId, consumerGroup }</code> into the <code>processedevents</code> collection. Because that field has a unique index, any duplicate insertion throws a duplicate key error (code 11000), which immediately aborts the transaction without touching business data.
</details>

<details>
<summary><b>4. Why does the expiration service not need a Transactional Outbox?</b></summary>
Because <code>expiration</code> has no MongoDB database! It uses Redis with a Bull queue. The Bull queue job itself is persisted on disk via Redis AOF (Phase 01) and retries on failure (Phase 02). The Bull queue acts as its own outbox.
</details>

<details>
<summary><b>5. Why do we need a distributed leader lease for the OutboxRelay if we scale a service to 3 pods?</b></summary>
If 3 pods simultaneously query the outbox collection for unpublished rows, they could read the same rows at the same time and publish them concurrently, scrambling the chronological order and creating unnecessary duplicates. The lease guarantees that only one pod acts as the relay leader at a time.
</details>
