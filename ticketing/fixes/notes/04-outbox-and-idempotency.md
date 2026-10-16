# Phase 04 Notes — Transactional Outbox & Idempotent Consumers

## 1. Architectural Motivation: Eliminating the Dual-Write Vulnerability

Prior to Phase 04, every business mutation in our microservices executed dual-writes sequentially without atomicity:
```ts
await entity.save();           // 1. Committed to MongoDB
await publisher.publish(data); // 2. Sent directly to Kafka over network
```
If the service pod crashed, or Kafka suffered a transient outage, or a network partition occurred between step 1 and step 2:
- The database change was saved.
- The downstream event was never published.
- Downstream services (e.g. `orders`, `tickets`, `expiration`, `payments`) remained permanently out of sync.

Swapping the order (`publish` before `save`) had the inverse flaw: publishing an event for an entity whose DB write failed (producing phantom events).

---

## 2. The Solution: Transactional Outbox Pattern

In Phase 04, we introduced the **Transactional Outbox** pattern:
```
┌─────────────────────────────────────────────────────────────┐
│                 Single MongoDB Transaction                  │
│                                                             │
│  1. Business Collection (e.g., tickets, orders, payments)   │
│     -> Insert / Update Entity document                      │
│                                                             │
│  2. OutboxEvents Collection                                 │
│     -> Insert OutboxEvent document (topic, key, payload)   │
│                                                             │
│            Both commit together, or neither commits!        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
        OutboxRelay (Background Polling Loop in Each Service)
        - Runs every 200ms
        - Coordinates with distributed `Lease` across multi-pod replicas
        - Dispatches unpublished events to Kafka partitions using partition keys
        - Marks `status: "published"` and records `publishedAt`
```

### Components in `@mehul-mrtickets/common@3.0.0`
1. **`OutboxEvent` Model**:
   - Fields: `eventId`, `topic`, `key`, `eventType`, `payload`, `status`, `headers`, `publishedAt`.
   - Polling Index: `{ status: 1, createdAt: 1 }` for high-throughput sequential polling.
   - TTL Index: Automatically expires published events after 7 days (`expireAfterSeconds: 604800`).
2. **`OutboxPublisher<T>` Base Class**:
   - Replaces direct network producer publishing with atomic local DB writes:
     ```ts
     await new TicketCreatedPublisher().publish(data, session);
     ```
   - Automatically populates `eventId`, `occurredAt`, topic mapping, and partition key.
3. **`Lease` Distributed Lock**:
   - Uses atomic MongoDB `findOneAndUpdate` with lease expiration (default 10s) to elect a single active `OutboxRelay` worker among multiple service replicas.
4. **`OutboxRelay` Polling Engine**:
   - Acquires/renews lease, polls unpublished rows (`status: "pending"`), publishes to Kafka, and updates status to `"published"`.
   - On shutdown, releases lease gracefully and drains in-flight dispatches.

---

## 3. Idempotent Consumer & Deduplication Engine

The Outbox guarantees **at-least-once** publishing. To convert at-least-once delivery into **effectively-once** execution, consumers must be idempotent.

### Components in `@mehul-mrtickets/common@3.0.0`
1. **`ProcessedEvent` Model**:
   - Unique compound index: `{ eventId: 1, consumerGroup: 1 }`.
   - TTL index: 7 days (`expireAfterSeconds: 604800`), matching Kafka topic retention.
2. **`EventConsumer` with `{ deduplicate: true, connection }`**:
   - In each incoming message:
     ```ts
     await connection.transaction(async (session) => {
         // Insert into ProcessedEvents
         await ProcessedEvent.create([{ eventId, consumerGroup }], { session });
         // Execute listener business logic with the exact same session
         await listener.onMessage(data, { eventId, occurredAt, session });
     });
     ```
   - If a duplicate message arrives:
     - The MongoDB unique constraint (`code: 11000`) catches the collision immediately.
     - The entire transaction aborts.
     - The message is skipped safely and committed with zero side effects.
   - If the listener throws an error:
     - The transaction rolls back, which also rolls back the `ProcessedEvent` record!
     - The event can be retried or dead-lettered without being prematurely marked as processed.

---

## 4. Service Implementations

### Tickets Service
- Upgraded routes (`/api/tickets` POST & PUT) and listeners (`OrderCreatedListener`, `OrderCancelledListener`) to transactional outbox.
- `EventConsumer` configured with `{ deduplicate: true, connection: mongoose.connection }`.
- `OutboxRelay` active in background.
- Test suite: 7/7 suites passed (23/23 tests).

### Orders Service
- Upgraded routes (`/api/orders` POST & DELETE) and listeners (`TicketCreatedListener`, `TicketUpdatedListener`, `ExpirationCompleteListener`, `PaymentCreatedListener`).
- Atomic check-and-reserve (`Ticket.reserve(ticketId, orderId, session)`) and cancellation release (`Ticket.release(ticketId, orderId, session)`) committed inside the order transaction.
- Test suite: 7/7 suites passed (20/20 tests).

### Payments Service
- Stripe charge executed first with `idempotencyKey: charge-${orderId}`.
- Database write (Payment record + `PaymentCreatedPublisher` outbox event) committed atomically in a MongoDB transaction.
- Listeners execute within `metadata.session`.
- Test suite: 3/3 suites passed (11/11 tests).

### Auth & Expiration Services
- Both bumped to `@mehul-mrtickets/common@3.0.0`.
- Auth test suite: 4/4 suites passed (12/12 tests).
- Expiration uses Bull Redis queue with `jobId: order-${data.id}` as its natural deduplication and outbox mechanism.

---

## 5. Summary of Test Results

| Microservice | Test Suites | Tests Passed | Tests Failed |
|---|---|---|---|
| `tickets` | 7 / 7 | 23 | 0 |
| `orders` | 7 / 7 | 20 | 0 |
| `payments` | 3 / 3 | 11 | 0 |
| `auth` | 4 / 4 | 12 | 0 |
| **Total** | **21 / 21** | **66** | **0** |
