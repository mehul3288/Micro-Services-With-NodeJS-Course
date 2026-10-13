# Engineering Notes: Concurrency, Race Conditions & Idempotency

## 1. The Anatomy of Check-Then-Act (TOCTOU)

A **Time-Of-Check to Time-Of-Use (TOCTOU)** bug occurs when a system reads shared state, makes a decision based on what it saw, and then acts on that decision in a separate operation.

### The Broken Pattern
```ts
// ❌ BROKEN: Reading and writing in two distinct operations
const ticket = await Ticket.findById(ticketId);
if (await ticket.isReserved()) {
    throw new BadRequestError("Ticket is already reserved");
}

// ⚠️ TIME WINDOW HERE: Another concurrent request enters and sees the ticket as available!

const order = Order.build({ ... });
await order.save();
```

Under 100 concurrent requests, all 100 read requests execute before any write commits. Every single request believes the ticket is available. As a result, 100 orders are created for 1 physical ticket.

### The Fix: Single-Operation Atomic Conditional Write
MongoDB documents are individually atomic. By moving the check directly into the query predicate of the update operation, the database engine locks the document row/memory during the update:

```ts
// ✅ ATOMIC: The check and the write happen in a single engine operation
ticketSchema.statics.reserve = (ticketId: string, orderId: string) => {
    return Ticket.findOneAndUpdate(
        { _id: ticketId, reservedBy: null },
        { $set: { reservedBy: orderId } },
        { returnDocument: "after" }
    );
};
```
If 100 requests hit this simultaneously, the database serializes the operations. Exactly **one** request matches `{ reservedBy: null }` and modifies the document. The remaining 99 find 0 matching documents and return `null`, allowing immediate rejection with HTTP 400.

---

## 2. Why Not Version Increment in Read Replicas?

In Mongoose, calling `ticket.save()` triggers the `@mehul-mrtickets/common` OCC (Optimistic Concurrency Control) plugin, incrementing `version` from `0` to `1`.

In the `orders` service, the `Ticket` collection is a **replicated projection** of the primary `tickets` service. The order service listeners expect updates to arrive with sequential version numbers:
```ts
Ticket.findOne({ _id: data.id, version: data.version - 1 })
```
If `orders` locally increments the ticket's version upon reservation, the next event from `tickets` (`version: 1`) will look for `version: 0`, but find `version: 1`. The event pipeline halts forever because the versions are out of sync.

**Rule:** Read-replica projections must only change version numbers when handling authoritative primary service events. Local reservations must use `findOneAndUpdate` or `updateOne`, which bypass the Mongoose OCC version hook.

---

## 3. Three-Layer Defense in Depth for Payments

Payments require multiple independent safety nets to protect against double-charging customers:

```text
┌───────────────────────────────────────────────────────────┐
│ Layer 1: Application-Level Check                          │
│ Payment.findOne({ orderId })                              │
│ Catches sequential double-clicks (user clicks twice)      │
└──────────────────────────┬────────────────────────────────┘
                           │ (Concurrent requests pass through)
                           ▼
┌───────────────────────────────────────────────────────────┐
│ Layer 2: Payment Provider Idempotency Key                 │
│ idempotencyKey: `charge-${orderId}`                       │
│ Stripe returns identical charge; card charged once only   │
└──────────────────────────┬────────────────────────────────┘
                           │ (Both requests get Stripe charge)
                           ▼
┌───────────────────────────────────────────────────────────┐
│ Layer 3: Database Unique Index Constraint                 │
│ orderId: { type: String, unique: true }                   │
│ Catches Mongo E11000 duplicate key error and returns 400  │
└───────────────────────────────────────────────────────────┘
```

### Why OrderId is the Natural Key
Unlike arbitrary random UUIDs sent in headers by clients, `orderId` represents the immutable business entity: **an order cannot be paid twice**. Using `charge-${orderId}` guarantees idempotency without requiring client-side coordination.

---

## 4. The IEEE-754 Money Trap

JavaScript numbers are 64-bit binary floating-point numbers (`IEEE 754`). They cannot accurately represent base-10 fractional numbers:
```js
19.99 * 100 === 1998.9999999999998
```
Passing this directly to Stripe (or any integer-cent API) causes truncation:
```js
Math.floor(19.99 * 100) === 1998 // Stole 1 cent from the customer!
```
Always use `Math.round(order.price * 100)` when converting decimal currency to minor units (cents).

---

## 5. Event Listener Reliability & Process Termination

Express route handlers run within an HTTP request-response cycle managed by Express. When an error is thrown in a route handler, Express catches it and forwards it to `errorHandler`.

Event listeners (NATS, Kafka, RabbitMQ) do **not** run inside Express:
- They run on the process event loop.
- If an `async` listener function throws an error or rejects a Promise and is not awaited/caught, Node.js treats it as an **Unhandled Promise Rejection**.
- In modern Node.js versions, unhandled rejections trigger `process.exit(1)` and terminate the container.

### The Hardened Listener Boundary (`@mehul-mrtickets/common`)
```ts
subscription.on("message", async (msg: Message) => {
    console.log(`Message received: ${this.subject} / ${this.queueGroupName}`);
    const parsedData = this.parseMessage(msg);
    try {
        await this.onMessage(parsedData, msg);
    } catch (err) {
        console.error(`Error processing message ${this.subject}:`, err);
        // Do NOT msg.ack(). The message will be redelivered.
        // Do NOT let the error escape, preventing pod crashes.
    }
});
```

---

## 6. Queue Deduplication with Bull

Delayed queues (like expiration timers) can receive duplicate `order:created` events due to network retries or NATS redeliveries.

By supplying `jobId: data.id`:
```ts
await expirationQueue.add(
    { orderId: data.id },
    { delay, jobId: data.id }
);
```
Bull enforces that only **one** job with a given ID can exist in the queue at any time. Any duplicate jobs are silently discarded, preventing premature or duplicate expiration events.
