# Concept Lesson 03: Apache Kafka, Partitioning, and Event Streaming Reliability

## 1. Why We Are Replacing NATS Streaming (STAN)

In the original course codebase, event communication was implemented using **NATS Streaming (STAN)**.
While STAN was simple to demo, it suffers from severe limitations:
1. **Deprecated & End-of-Life:** STAN was officially deprecated by the NATS team in 2023 in favor of JetStream. Running deprecated infrastructure in production is a critical risk.
2. **Broken Ordering with Queue Groups:** In STAN, when multiple pods joined a queue group, messages were distributed round-robin. If message delivery failed and was redelivered, newer messages could be processed ahead of older ones, breaking chronological ordering.
3. **Limited Replay & Ecosystem:** STAN lacked robust partition replaying, distributed tracing integrations, and modern schema governance.

**Apache Kafka** is the industry standard for distributed event streaming. It solves ordering fundamentally through its **partitioning model**.

---

## 2. Kafka Mental Model: Queues vs Append-Only Logs

Traditional message brokers (RabbitMQ, basic NATS) operate as **queues**:
- A producer pushes a message into a queue.
- A consumer pulls it. Once acknowledged, the broker **deletes** the message.
- "Smart Broker, Dumb Consumer": The broker tracks every consumer's individual message state.

Kafka operates as an **Append-Only Distributed Commit Log**:
- A topic is an ordered, immutable log on disk.
- Producers append events to the end of the log.
- Consumers read events sequentially by tracking an integer pointer called an **offset**.
- Events are **NOT deleted** when read. They remain on disk until their retention period expires (e.g., 7 days).
- "Dumb Broker, Smart Consumer": The broker merely stores ordered bytes; the consumers track and commit their own offsets. Consumers can rewind their offset to replay events from 3 days ago if a bug is fixed!

```text
Topic: ticket-events (Partition 0)
┌───────────┬───────────┬───────────┬───────────┬───────────┐
│ Offset 0  │ Offset 1  │ Offset 2  │ Offset 3  │ Offset 4  │ ...
│ Ticket-A  │ Ticket-B  │ Ticket-A  │ Ticket-C  │ Ticket-A  │
└───────────┴───────────┴───────────┴───────────┴───────────┘
                                       ▲
                               Consumer Offset = 3
```

---

## 3. The Golden Rule of Partitioning & Ordering

> **Kafka guarantees strict message ordering ONLY within a single partition.**
> Across different partitions, messages can be read in any order.

When a message is produced to Kafka with a **key**, Kafka hashes the key:
$$\text{Partition} = \text{murmur2}(\text{key}) \pmod{\text{Total Partitions}}$$

All messages with the **same key** will ALWAYS land on the **exact same partition**. Because a partition is read sequentially, those messages are guaranteed to be consumed in the exact order they were produced.

### The Million-Dollar Question: What should the Partition Key be?

> **Rule:** *Always key by the entity whose business invariants and state transitions you need to protect.*

Let's look at `order-events` (`OrderCreated`, `OrderCancelled`):
- **Naive approach:** Key by `order.id`.
  - Order 1 and Order 2 for the same physical ticket end up on *different* partitions!
  - Consumer A reads Partition 0 (`OrderCancelled` for Order 1).
  - Consumer B reads Partition 1 (`OrderCreated` for Order 2).
  - Due to network timing, Consumer B applies `OrderCreated` first (ticket reserved for Order 2), then Consumer A applies `OrderCancelled` second (clearing `reservedBy` to `null`).
  - **Result:** The ticket is accidentally made available to everyone while Order 2 is actively awaiting payment!
- **The Correct Design:** Key `order-events` by **`ticket.id`**!
  - Every single lifecycle event affecting Ticket-X—whether it is created, cancelled, or recreated—lands on the **exact same partition**.
  - A single consumer processes events for Ticket-X strictly in sequence. The race condition becomes physically impossible.

| Topic | Events | Partition Key | Business Invariant Protected |
|---|---|---|---|
| `ticket-events` | `TicketCreated`, `TicketUpdated` | `ticket.id` | Sequential version updates for ticket attributes |
| `order-events` | `OrderCreated`, `OrderCancelled` | **`ticket.id`** | Sequential reservations & cancellations for a ticket |
| `payment-events` | `PaymentCreated` | `orderId` | Payments processed strictly per order |
| `expiration-events`| `ExpirationComplete` | `orderId` | Expirations processed strictly per order |

---

## 4. Consumer Groups & Scaling

Kafka scales horizontally through **Consumer Groups**:
- Every service specifies a consumer group ID (e.g. `groupId: "orders-service"`).
- Kafka automatically assigns the partitions of a topic evenly among the active pods in that consumer group.
- **Rule:** If a topic has **3 partitions**, you can have up to **3 consumer pods** processing data in parallel. If you scale to 4 pods, the 4th pod will sit idle as a hot standby.
- If a pod crashes, Kafka triggers a **rebalance** and reassigns the dead pod's partitions to surviving pods without dropping messages.

```text
                  Topic: ticket-events (3 Partitions)
                    ┌─────────────┐
                    │ Partition 0 │ ──────────► Pod 1 (orders-depl-xxx)
                    └─────────────┘
                    ┌─────────────┐
                    │ Partition 1 │ ──────────► Pod 2 (orders-depl-yyy)
                    └─────────────┘
                    ┌─────────────┐
                    │ Partition 2 │ ──────────► Pod 3 (orders-depl-zzz)
                    └─────────────┘
```

---

## 5. Reliability: The Poison Pill & Dead Letter Queue (DLQ)

### What is a "Poison Pill"?
Suppose a producer emits an event with malformed JSON, or a listener hits a bug (e.g., trying to access `undefined.foo`).
If the consumer crashes or rejects the message without advancing the offset:
- On restart, the consumer reads the exact same offset again.
- It crashes again.
- **The entire partition is blocked indefinitely!** No other messages for any customer on that partition can be processed. This is called a **Head-of-Line Blocking** outage.

### The Dead Letter Queue (DLQ) Solution
To prevent poison pills from halting operations, the consumer follows a resilient error workflow:

```text
 Incoming Message from Kafka
             │
             ▼
      Parse JSON Payload
             │
      [Invalid JSON] ───► Forward immediately to <topic>.dlq ──► Commit offset ✅
             │
         [Valid]
             ▼
      Execute onMessage()
             │
        [Succeeds] ────────────────────────────────────────────► Commit offset ✅
             │
          [Fails]
             ▼
     Retry with Exponential Backoff (1s, 2s, 4s)
     * Calls heartbeat() to keep consumer alive in group
             │
   [All 3 Attempts Fail]
             ▼
  Publish to <topic>.dlq with Error Metadata Headers:
    - dlq-error: "TypeError: ..."
    - dlq-consumer-group: "orders-service"
    - dlq-original-topic: "ticket-events"
    - dlq-failed-at: ISO Timestamp
             │
             ▼
       Commit offset ✅ (Partition moves forward!)
```

### Blocking In-Process Retries vs Retry Topics
- **Blocking in-process retries (Our choice):** Retries the message up to 3 times before DLQing. Crucially, **it preserves ordering for that partition**. Because total retry time is ~7 seconds, healthy messages on the same partition only pause momentarily.
- **Retry topics (Uber pattern):** Pushing failed messages to `ticket-events.retry-5s`. While this avoids blocking the main partition, it destroys ordering because newer events for the same ticket bypass the retried event. For ticketing, preserving order is paramount!

---

## 6. Producer Reliability: Idempotent Producers

When a service publishes an event to Kafka over the network, network blips can cause timeouts:
- The broker received and stored the message.
- But the network dropped the broker's acknowledgment before reaching the publisher.
- If the publisher retries sending the message, the broker could store a **duplicate**.

By enabling Kafka's **Idempotent Producer**:
```ts
const producer = kafka.producer({
    idempotent: true,
    maxInFlightRequests: 1,
    acks: -1 // all in-sync replicas must acknowledge
});
```
Kafka assigns a Producer ID (PID) and sequence numbers to every message. If the broker receives a message with a sequence number it has already stored, it discards the duplicate write while acknowledging the publisher.

> **Important Interview Distinction:**
> An *idempotent producer* only protects against **network-level retries between the publisher client and Kafka**.
> It does NOT protect against **application-level duplicate writes** (e.g., if your code accidentally executes `publish()` twice for two different orders). Application-level deduplication requires idempotent consumers (which we implement in Phase 04).

---

## 7. KRaft: Kafka Without ZooKeeper

Historically, Apache Kafka required a separate cluster called **Apache ZooKeeper** to store broker metadata, topic partition state, and elect the controller broker.
ZooKeeper added immense operational complexity, slow metadata synchronization, and dual maintenance overhead.

Since Kafka 3.x, Kafka operates in **KRaft mode (Kafka Raft)**:
- Metadata is stored directly inside an internal, replicated Kafka topic (`@metadata`).
- Raft consensus is used natively within the Kafka brokers.
- ZooKeeper is completely removed.
- Failover is instant, startup is faster, and Kubernetes deployments require only a single StatefulSet.

---

## 8. Summary of Migration Plan

1. **Common Package 2.0.0 (`@mehul-mrtickets/common`):**
   - New `topics.ts` mapping subjects to topics.
   - Refactored `Publisher` (requiring `partitionKey()`).
   - Refactored `Listener` (taking clean metadata, no `msg.ack()`).
   - New `EventConsumer` with JSON validation, blocking retries, and automatic DLQ routing.
2. **Kubernetes Infrastructure:**
   - Remove `nats-depl.yaml`.
   - Deploy `kafka-statefulset.yaml` using KRaft mode with persistent volume storage.
3. **Services Migration:**
   - Replace `nats-wrapper.ts` with `kafka-wrapper.ts` across `tickets`, `orders`, `payments`, `expiration`.
   - Update publishers to supply partition keys.
   - Update `index.ts` to register listeners into `EventConsumer`.
   - Update all mock wrappers and test suites.
4. **Verification & Tooling:**
   - Inspect live Kafka partition keys with `kafka-console-consumer`.
   - Test DLQ routing with synthetic failures.
   - Run end-to-end load tests.
