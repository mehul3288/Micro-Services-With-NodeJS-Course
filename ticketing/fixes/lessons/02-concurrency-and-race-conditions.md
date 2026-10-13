# Phase 02 Lesson: Concurrency, Race Conditions & Distributed Idempotency

Welcome to **Phase 02**. In Phase 01, we solidified our infrastructure: our databases persist data across pod crashes, our pods have health probes, and rolling updates drain traffic with zero downtime.

Now, we face the most dangerous class of bugs in distributed systems: **Business-Logic Concurrency Bugs**.

In Phase 00, our baseline load tests proved two critical flaws in the original codebase:
1. **Overselling:** During a flash sale (`flash-sale-race.js`), multiple users bought the exact same ticket simultaneously.
2. **Double Charging:** When double-clicking checkout (`double-payment.js`), the customer was charged 10 times for a single order.

This lesson breaks down why these bugs happen and the battle-tested engineering patterns to eliminate them.

---

## 1. The Check-Then-Act Flaw (TOCTOU: Time-Of-Check to Time-Of-Use)

### The Bug in the Original Code
Look at `orders/src/routes/new.ts`:
```ts
// 1. CHECK
const isReserved = await ticket.isReserved();
if (isReserved) {
    throw new BadRequestError("Ticket is already reserved");
}

// 2. ACT
const order = Order.build({ ... });
await order.save();
```

### The Movie Theater Seat Analogy
Imagine a movie theater website with **1 remaining VIP seat**:
1. User Alice opens the page at 12:00:00.000. Her app checks: *"Is the seat booked?"* The database says **"No"**.
2. User Bob opens the page at 12:00:00.002. His app checks: *"Is the seat booked?"* The database says **"No"**.
3. Alice clicks "Confirm & Reserve". Her server sends `order.save()`.
4. Bob clicks "Confirm & Reserve". His server sends `order.save()`.
5. **Result:** Both orders are saved in the database with status `created`. Both Alice and Bob arrive at the cinema holding valid tickets for the exact same seat.

### Why "Adding Another Check" Never Fixes a Race
In high-concurrency systems, **a check and a subsequent write are two completely separate network round-trips to the database.** 
Between the moment Query 1 returns and Write 1 executes, dozens or hundreds of concurrent requests can execute on other CPU cores or across multiple pods.

```text
Time       Pod 1 (Alice)                      Database                      Pod 2 (Bob)
─────────────────────────────────────────────────────────────────────────────────────────────
t0         Is ticket reserved? ─────────────► No
t1                                            No ◄───────────────────────── Is ticket reserved?
t2         Save Order A ────────────────────► Order A saved
t3                                            Order B saved ◄────────────── Save Order B
─────────────────────────────────────────────────────────────────────────────────────────────
Outcome:   TWO active orders pointing to ONE ticket! (Double sold)
```

---

## 2. The Solution: Atomic Conditional Updates

To eliminate the race condition, we must collapse the **Check** and the **Act** into a **single, indivisible database operation**.

### Single-Document Atomicity in MongoDB
In MongoDB (and SQL databases), single-document updates are **guaranteed to be atomic**. If 500 requests try to update the exact same document at the exact same millisecond, MongoDB's storage engine (WiredTiger) serializes them document-by-document using row-level latches.

### The `reservedBy` Pattern
Instead of searching across an external collection of orders to see if an order exists, the `Ticket` document inside the orders service tracks its reservation directly:
```ts
interface TicketDoc extends mongoose.Document {
    title: string;
    price: number;
    version: number;
    reservedBy?: string | null; // Stores orderId of the active reservation
}
```

Now, reservation becomes a single conditional atomic update:
```ts
ticketSchema.statics.reserve = (ticketId: string, orderId: string) => {
    return Ticket.findOneAndUpdate(
        { _id: ticketId, reservedBy: null },       // <-- CONDITION (Check)
        { $set: { reservedBy: orderId } },         // <-- MUTATION (Act)
        { new: true }
    );
};
```

### How WiredTiger Handles 500 Simultaneous Requests
```text
Pod 1 (Alice): findOneAndUpdate({ _id: ticketId, reservedBy: null }, { reservedBy: orderA })
Pod 2 (Bob):   findOneAndUpdate({ _id: ticketId, reservedBy: null }, { reservedBy: orderB })
Pod 3 (Carol): findOneAndUpdate({ _id: ticketId, reservedBy: null }, { reservedBy: orderC })
```
- MongoDB evaluates **Alice's query first**. `reservedBy` is currently `null`. The condition matches! MongoDB sets `reservedBy: orderA` and returns the updated document.
- MongoDB immediately evaluates **Bob's query**. `reservedBy` is now `orderA`, NOT `null`! The condition **fails to match**. MongoDB updates 0 documents and returns `null`.
- Bob's route handler sees `null` and throws:
  ```ts
  throw new BadRequestError("Ticket is already reserved");
  ```
- **Only Alice gets the ticket. Exactly 1 order is created.**

### The Critical Mongoose OCC Trap (Why we don't use `ticket.save()`)
In the ticketing microservices architecture, the `Ticket` model in the `orders` service is a **read replica** synchronized via NATS events from the `tickets` service.
- The `version` field on the ticket in the orders service must match the event versions from the primary service (`version - 1` ordering check).
- If you use `ticket.reservedBy = order.id; await ticket.save()`, Mongoose's Optimistic Concurrency Control (OCC) plugin will automatically increment `version: 0 → 1`!
- When the primary `tickets` service later publishes an update with `version: 1`, the orders listener will look for `version: 0`, fail to find it, and hang or drop the event!
- **Rule:** `findOneAndUpdate` directly modifies the document in MongoDB **without triggering Mongoose's version increment hook**, keeping the event stream version contract intact.

---

## 3. Defense in Depth: Preventing Double Charges

Why did double-clicking payment charge the customer multiple times?
Because `payments/src/routes/new.ts` simply took an order ID and immediately called `stripe.charges.create()`!

In financial systems, a single bug can cost thousands of dollars and trigger bank chargeback fees. Production payment flows require **Defense in Depth**: three overlapping protective layers.

```
Incoming Payment Request
         │
         ▼
┌──────────────────────────────────────────────────────────────────┐
│ Layer 1: Application Check                                       │
│ Payment.findOne({ orderId }) -> 400 "Order already paid"         │
└──────────────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────────┐
│ Layer 2: Payment Gateway Idempotency (Stripe)                    │
│ idempotencyKey: `charge-${orderId}`                              │
│ Stripe executes charge once; subsequent requests return cached 200│
└──────────────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────────┐
│ Layer 3: Database Unique Constraint                              │
│ unique index on Payment.orderId -> E11000 Duplicate Key Error    │
└──────────────────────────────────────────────────────────────────┘
```

### Layer 1: Application-Level Check
If a user pays, waits 5 seconds, and accidentally clicks Pay again:
```ts
const existingPayment = await Payment.findOne({ orderId });
if (existingPayment) {
    throw new BadRequestError("Order is already paid");
}
```
Catches sequential duplicate requests immediately without consuming third-party API rate limits.

### Layer 2: Payment Provider Idempotency Key
What if two payment requests arrive at the **exact same millisecond** from two tabs? Both requests pass Layer 1.
If both call Stripe, Stripe will charge the credit card twice!

To prevent this, Stripe and all major payment gateways accept an **Idempotency Key**:
```ts
const charge = await stripe.charges.create(
    {
        currency: "usd",
        amount: Math.round(order.price * 100),
        source: token,
    },
    {
        idempotencyKey: `charge-${orderId}` // <-- STRIPE IDEMPOTENCY KEY
    }
);
```
- When Stripe receives a request with an `idempotencyKey`, Stripe checks its internal cache.
- If it has never seen this key, Stripe executes the credit card transaction and caches the response.
- If a duplicate request arrives with the exact same key within 24 hours, **Stripe does NOT charge the credit card again.** It simply returns the exact same successful charge object!

### Layer 3: Database Unique Constraint
Even if Stripe handles idempotency, we must ensure our local database never stores two `Payment` records for the same order:
```ts
const paymentSchema = new mongoose.Schema({
    orderId: {
        type: String,
        required: true,
        unique: true // <-- UNIQUE INDEX
    },
    stripeId: {
        type: String,
        required: true
    }
});
```
MongoDB's unique index on `orderId` acts as the final mathematical safety net.

### The JavaScript IEEE-754 Money Trap
In JavaScript:
```js
19.99 * 100 === 1998.9999999999998 // True!
```
Stripe expects the payment amount as an integer number of cents. Passing `1998.9999999999998` to Stripe can cause API schema validation errors or truncation.
**Rule:** Always round money calculations:
```ts
amount: Math.round(order.price * 100)
```

---

## 4. State Machine Integrity: Cancelling Paid Orders

In `orders/src/routes/delete.ts`, the original code allowed cancelling an order as long as the user owned it.
What happened if the customer had already paid?
- The order status was changed to `cancelled`.
- An `OrderCancelled` event was published.
- The ticket was unlocked and sold to someone else!
- But the original customer had already been charged their money!

### The State Machine Fix
```ts
if (order.status === OrderStatus.Complete) {
    throw new BadRequestError("Cannot cancel a paid order");
}

if (order.status === OrderStatus.Cancelled) {
    return res.status(204).send(order); // Idempotent: already cancelled
}
```
1. Paid orders cannot be cancelled via the standard delete route. (Refund workflows belong in Phase 05).
2. Cancelling an already-cancelled order is **idempotent**: it returns `204 No Content` without publishing a duplicate `OrderCancelled` event to NATS.

---

## 5. Listener Reliability: Awaited Promises & Error Boundaries

### The Silent Crash Trap in `base-listener.ts`
Look at line 42 in `common/src/events/base-listener.ts`:
```ts
subscription.on("message", (msg: Message) => {
    const parsedData = this.parseMessage(msg);
    this.onMessage(parsedData, msg); // <-- NOT AWAITED!
});
```

Because `onMessage` is an `async` function returning a Promise:
1. When `onMessage` runs and encounters an error (e.g., ticket not found, or MongoDB write error), the Promise rejects.
2. Because nobody called `.catch()` or `await` inside a `try/catch`, this becomes an **Unhandled Promise Rejection**.
3. In Node.js 16+, unhandled rejections **terminate the process (`process.exit(1)`)**!
4. A single malformed message or race condition in one listener crashed the entire microservice pod!

### The Error Boundary Fix
```ts
subscription.on("message", async (msg: Message) => {
    const parsedData = this.parseMessage(msg);
    try {
        await this.onMessage(parsedData, msg);
    } catch (err) {
        console.error(`Failed to process event ${this.subject}:`, err);
        // By NOT calling msg.ack(), NATS will automatically redeliver the event
    }
});
```
- Any error thrown inside `onMessage` is caught cleanly.
- The pod does NOT crash.
- Because `msg.ack()` is only called inside `onMessage` when processing succeeds, an error leaves the message unacknowledged. NATS Streaming will redeliver it after `ackWait` expires.

---

## 6. Bull Queue Deduplication in the Expiration Service

In `expiration/src/events/listeners/order-created-listener.ts`:
```ts
const delay = Math.max(new Date(data.expiresAt).getTime() - Date.now(), 0);

await expirationQueue.add(
    { orderId: data.id },
    {
        delay,
        jobId: data.id // <-- BULL DEDUPLICATION KEY
    }
);
```

### Why `jobId` Matters
If NATS redelivers an `OrderCreated` event twice due to network delay, without `jobId`, Bull would create two separate delayed timers for the same order, firing two `ExpirationComplete` events.
By supplying `jobId: data.id`, Bull checks Redis. If a job with ID `data.id` already exists in the queue, **Bull discards the duplicate job**.
This creates an **Idempotent Consumer** with zero extra database queries!

---

## Summary Checklist for Phase 02

1. **Orders Service:**
   - Add `reservedBy` field to `Ticket` model.
   - Implement atomic `Ticket.reserve(ticketId, orderId)` and `Ticket.release(ticketId, orderId)`.
   - Remove check-then-act `isReserved()` calls.
   - Prevent cancelling `Complete` orders in `deleteOrderRouter`.
2. **Payments Service:**
   - Add Layer 1 check (`Payment.findOne({ orderId })`).
   - Add Layer 2 Stripe `idempotencyKey: charge-${orderId}`.
   - Add Layer 3 unique index on `Payment.orderId`.
   - Round Stripe amounts with `Math.round(order.price * 100)`.
   - Validate `orderId` is a valid Mongo ID.
3. **Common Package:**
   - Update `base-listener.ts` to `await` and `try/catch` `onMessage`.
   - Publish `@mehul-mrtickets/common`.
4. **Expiration Service:**
   - Set `jobId: data.id` on Bull delayed queue.
   - Clamp delay to `Math.max(..., 0)`.
   - `await` the NATS publish inside `expirationQueue.process()`.
5. **Verification:**
   - Run `flash-sale-race.js` with k6 (verify strictly 1 order created).
   - Run `double-payment.js` with k6 (verify strictly 1 payment created).
   - Verify all unit and integration tests pass.
