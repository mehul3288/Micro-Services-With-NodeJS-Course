# Engineering Notes: Kafka Partitioning, Ordering & Dead Letter Queues

## 1. Partition Key Selection: Key by the Protected Invariant

In Apache Kafka, order is **strictly guaranteed within a partition**, never across partitions or across different topics. Messages sharing the same non-null partition key are routed to the exact same partition via consistent hashing (`murmur2(key) % num_partitions`).

### The Counterintuitive Choice: Keying `order-events` by `ticket.id`
When designing `order-events` (which publishes `OrderCreated` and `OrderCancelled`), the intuitive developer choice is often `order.id`. **This is dangerous in a reservation system.**

Consider two consecutive orders competing for `Ticket-X`:
```text
1. User A creates Order-1 for Ticket-X
2. User A cancels Order-1               → OrderCancelled(order-1, ticket: Ticket-X)
3. User B immediately creates Order-2   → OrderCreated(order-2, ticket: Ticket-X)
```

If `order-events` is keyed by `order.id`:
- `OrderCancelled(order-1)` hashes to **Partition 0** (key: `order-1`).
- `OrderCreated(order-2)` hashes to **Partition 2** (key: `order-2`).
- The `tickets` service has concurrent consumers processing Partition 0 and Partition 2 independently.
- If Partition 2 processes faster than Partition 0:
  ```text
  tickets service consumes OrderCreated(order-2)   → ticket.orderId = order-2
  tickets service consumes OrderCancelled(order-1) → ticket.orderId = undefined  ❌ BUG!
  ```
  `Ticket-X` is now cleared and marked available for anyone to grab, even though `Order-2` is active and waiting for payment!

### The Rule
> **Always key events by the entity whose business invariants and lifecycle state you are protecting.**

Because the invariant being protected is **ticket reservation exclusivity**, all order lifecycle events touching a ticket must be keyed by `ticket.id`:
```ts
export class OrderCreatedPublisher extends Publisher<OrderCreatedEvent> {
    readonly subject = Subjects.OrderCreated;
    partitionKey(data: OrderCreatedEvent["data"]): string {
        return data.ticket.id;
    }
}
```
Now, `OrderCancelled(order-1)` and `OrderCreated(order-2)` produce to the **same partition**. Any consumer assigned to that partition will process cancellation before creation, eliminating race conditions.

### Defensive Layer: Guarding Against Out-of-Band Stale Events
Even with deterministic partitioning, network anomalies or replays could introduce out-of-sequence events. In `OrderCancelledListener` within `tickets`, a defensive equality check ensures we never clear a reservation held by a different order:
```ts
// tickets/src/events/listeners/order-cancelled-listener.ts
const ticket = await Ticket.findById(data.ticket.id);
if (!ticket) {
    throw new Error("Ticket not found");
}

// DEFENSIVE CHECK: Only clear if this exact order holds the reservation
if (ticket.orderId !== data.id) {
    return; // Stale or obsolete cancel event; ignore safely
}

ticket.set({ orderId: undefined });
await ticket.save();
```

---

## 2. Consumer Groups & Horizontal Scaling

A Kafka **Consumer Group** coordinates multiple instances of a service so that each partition is consumed by exactly one instance in the group.

```text
Topic: order-events (3 Partitions: P0, P1, P2)

Case 1: 1 Pod (orders-depl replica 1)
  Pod 1 ──► [ P0, P1, P2 ]

Case 2: 2 Pods
  Pod 1 ──► [ P0, P1 ]
  Pod 2 ──► [ P2 ]

Case 3: 3 Pods (Optimal)
  Pod 1 ──► [ P0 ]
  Pod 2 ──► [ P1 ]
  Pod 3 ──► [ P2 ]

Case 4: 4 Pods (Over-provisioned)
  Pod 1 ──► [ P0 ]
  Pod 2 ──► [ P1 ]
  Pod 3 ──► [ P2 ]
  Pod 4 ──► IDLE (Cannot read anything; maximum concurrency = partition count)
```

### Partition Sizing Principle
The number of partitions in a topic defines the **upper ceiling for horizontal scaling**. With 3 partitions per topic, a service can scale to at most 3 pods. Scaling to 5 pods leaves 2 pods completely idle. In production, topic partitions are set based on peak throughput forecasts (e.g., 6, 12, or 24 partitions).

### Heartbeats and Consumer Group Rebalancing
Kafka brokers track consumer liveness using heartbeats. If a consumer stops sending heartbeats or takes longer than `max.poll.interval.ms` to process a message batch, the group coordinator considers the consumer dead and triggers a **rebalance**.

During synchronous retries with backoff delays, the thread is blocked. To prevent premature rebalances, our `EventConsumer` explicitly calls `heartbeat()` during backoff sleep periods:
```ts
await sleep(delay);
await heartbeat(); // Signals coordinator: "I am alive and processing"
```

---

## 3. Poison Pills, Head-of-Line Blocking & DLQ Architecture

### What is a Poison Pill?
A **poison pill** is a message that cannot be processed successfully by a consumer under any circumstance. Examples include:
1. Corrupted payload or invalid JSON (`SyntaxError`).
2. Missing required fields or schema violations.
3. Logical defects in listener code that throw an unhandled exception for that specific input.

### Why Poison Pills Break Streaming Systems
In streaming architectures, consumers commit an **offset** representing the high watermark of processed messages:
```text
Partition 0: [ Msg 1 (ok) ] [ Msg 2 (Poison Pill) ] [ Msg 3 (valid) ] [ Msg 4 (valid) ]
                                   ▲
                             Consumer stuck
```
If the consumer crashes on Msg 2 without committing offset 2:
1. Kubernetes restarts the pod or Kafka assigns the partition to another pod.
2. The consumer resumes at offset 2 and crashes again.
3. **Head-of-Line Blocking:** Messages 3 and 4 (which are perfectly valid) can **never** be processed. The entire partition halts indefinitely.

### The Fix: Automatic DLQ Routing
The `@mehul-mrtickets/common` `EventConsumer` implements a strict isolation boundary:
1. **Unparseable JSON:** Immediately forwarded to `<topic>.dlq` without retry (retrying a malformed syntax error is futile).
2. **Runtime Exceptions:** Retried 3 times with exponential backoff (1s, 2s). If all attempts fail, routed to `<topic>.dlq`.
3. **Offset Commit:** The consumer commits the offset on the original topic and advances to the next message.

```text
Message arrives
   │
   ├─ JSON Parse? ── No ──► DLQ (<topic>.dlq) ──► Commit offset & continue
   │
   └─ Try 1, 2, 3 (Backoff + Heartbeats)
          │
          ├─ Success ──► Commit offset & continue
          └─ Exhausted ──► DLQ (<topic>.dlq) ──► Commit offset & continue
```

### Diagnostic Headers on DLQ Messages
When a message lands in the DLQ, all original payload bytes and headers are preserved, and critical debugging headers are attached:
- `dlq-error`: The exact `error.message` or stack trace.
- `dlq-consumer-group`: Identifies which service failed (`orders-service`, `tickets-service`, etc.).
- `dlq-original-topic`: The origin topic (`ticket-events`).
- `dlq-failed-at`: ISO timestamp of failure.

---

## 4. Retries: In-Process Blocking vs Retry Topics

When an event fails to process, two standard architectural patterns exist:

| Dimension | In-Process Blocking Retries (Ticketing System) | Retry Topics / Dead Letter Queues (e.g. Uber Pattern) |
|---|---|---|
| **Mechanism** | Consumer sleeps in-process with backoff and heartbeats (1s, 2s). | Consumer immediately republishes failed event to `topic.retry-10s`, `topic.retry-1m`. |
| **Per-Key Ordering** | **Strictly Preserved.** Newer events for the same key wait behind the retried event. | **Broken.** Newer events on the main topic pass ahead of the delayed message. |
| **Partition Head-of-Line** | Temporarily halts the partition for the retry duration (~3-7 seconds). | Completely non-blocking; main partition throughput remains high. |
| **Complexity** | Very low (in-process loop inside `EventConsumer`). | High (multiple delayed topics, scheduler/delay consumers, TTL management). |

### The Engineering Trade-off
For e-commerce and ticketing, **ordering per ticket is non-negotiable**. If an `OrderCreated` event fails due to a transient MongoDB connection blip, processing an incoming `OrderCancelled` ahead of it would corrupt inventory state. Hence, in-process blocking retries with a 3-attempt ceiling are the correct design.

---

## 5. Producer Idempotence & Apache Kafka KRaft

### Producer Idempotence (`idempotent: true`)
Network calls between producer and broker can fail after the broker writes the message but before sending the ACK. Without idempotence, the producer retries and produces a duplicate message.

By enabling `idempotent: true` and `maxInFlightRequests: 1`:
1. The broker assigns a unique **Producer ID (PID)** to each producer instance.
2. The producer tags each message with a monotonically increasing **Sequence Number**.
3. If the broker receives a duplicate sequence number from the same PID, it acknowledges the request but writes the message to the log only once.

### KRaft Mode (Kafka Raft Metadata)
Historically, Kafka relied on Apache ZooKeeper to manage cluster metadata, leader elections, and configuration state. 
With **KRaft** (Kafka 3.3+ production ready, 3.9 used here):
- ZooKeeper is completely removed.
- Kafka brokers use an internal Raft quorum (`@metadata` topic) to elect a Controller and replicate metadata.
- Benefits: Drastically simpler operational footprint, faster topic creation, instantaneous controller failover, and lower memory overhead in Kubernetes.
