# Phase 02 — Correctness & Concurrency

**Goal:** Remove every way the system can **oversell a ticket** or **charge a customer twice**,
and fix the smaller bugs found during review.

**Grouped because:** these are all business-correctness bugs in existing routes and listeners.
They need no new infrastructure, and they are the most important fixes in the project.

---

## 1. Bugs Found in the Current Code

| # | Bug | Where | Impact |
|---|---|---|---|
| 1 | Check-then-act race on ticket reservation | [orders/src/routes/new.ts](../orders/src/routes/new.ts) lines 23–42 | **Same ticket sold to many buyers** |
| 2 | Already-paid orders can be charged again | [payments/src/routes/new.ts](../payments/src/routes/new.ts) lines 30–38 | **Double charge** |
| 3 | No idempotency key on the Stripe call | same, line 34 | Network retry = second charge |
| 4 | A paid (`complete`) order can be cancelled | [orders/src/routes/delete.ts](../orders/src/routes/delete.ts) line 20 | Customer paid, ticket released to someone else |
| 5 | `onMessage` is not awaited and its errors are not caught | [common/src/events/base-listener.ts](../common/src/events/base-listener.ts) line 42 | A thrown `"Ticket not found"` becomes an **unhandled rejection → the pod crashes** |
| 6 | `publish()` is not awaited | [payments/src/routes/new.ts](../payments/src/routes/new.ts) line 46, [tickets order-created-listener.ts](../tickets/src/events/listeners/order-created-listener.ts) line 19 | Event can fail silently after the message is acked |
| 7 | `orderId` is not validated | [payments/src/routes/new.ts](../payments/src/routes/new.ts) line 15 | Invalid ObjectId → 500 instead of 400 |
| 8 | `order.price * 100` with floats | same, line 36 | `19.99 * 100 = 1998.9999...` → Stripe rejects or undercharges |
| 9 | Negative delay when the event arrives late | [expiration order-created-listener.ts](../expiration/src/events/listeners/order-created-listener.ts) line 10 | Works by accident; should be explicit |
| 10 | Duplicate `OrderCreated` delivery → duplicate expiry jobs | same, line 12 | Two `ExpirationComplete` events per order |

---

## 2. Fix #1 — Atomic Ticket Reservation

### The race today
```text
   Buyer A                        Mongo                         Buyer B
     │  isReserved()? ──────────►  no order found                  │
     │                             no order found  ◄──── isReserved()?
     │  order.save()  ──────────►  Order A                         │
     │                             Order B         ◄──── order.save()
     ▼                                                             ▼
                    TWO active orders for ONE ticket
```
The **check** and the **write** are two separate operations, and another request can run in between.

### The fix: make check + write one atomic operation
The orders service's `Ticket` replica gets a `reservedBy` field (the active order id).
Reserving the ticket becomes one conditional update. Mongo guarantees that only **one** request
can change `reservedBy` from `null` to a value, because single-document updates are atomic.

```text
   Buyer A ──► findOneAndUpdate({ _id, reservedBy: null }, { reservedBy: orderA })  ──► ✅ matched
   Buyer B ──► findOneAndUpdate({ _id, reservedBy: null }, { reservedBy: orderB })  ──► ❌ null (no match)
```

### Code sketch — `orders/src/routes/new.ts`
```ts
const order = Order.build({
    userId: req.currentUser!.id,
    status: OrderStatus.Created,
    expiresAt: expiration,
    ticket: ticket
});

// Atomic: only one request can move reservedBy from null to an order id
const reservedTicket = await Ticket.reserve(ticket.id, order.id);
if (!reservedTicket) {
    throw new BadRequestError("Ticket is already reserved");
}

await order.save();
```

### Code sketch — `orders/src/models/ticket.ts`
```ts
ticketSchema.statics.reserve = (ticketId: string, orderId: string) => {
    return Ticket.findOneAndUpdate(
        { _id: ticketId, reservedBy: null },
        { $set: { reservedBy: orderId } },
        { new: true }
    );
};

ticketSchema.statics.release = (ticketId: string, orderId: string) => {
    // Only the order that holds the reservation can release it
    return Ticket.updateOne(
        { _id: ticketId, reservedBy: orderId },
        { $set: { reservedBy: null } }
    );
};
```

`isReserved()` is removed; `reservedBy` is now the single source of truth.
`release()` is called wherever an order is cancelled: the delete route and `ExpirationCompleteListener`.

### Important gotcha: do not bump the version
The `Ticket` replica's `version` must **mirror the tickets service**, because `findByEvent` matches on
`version - 1`. `reserve` / `release` therefore use `findOneAndUpdate` / `updateOne`, which **skip** the
`pre("save")` hook that increments the version. Using `ticket.save()` here would silently break event ordering.

### Remaining gap (closed in Phase 04)
If the pod crashes **between** `reserve()` and `order.save()`, the ticket stays reserved with no order.
Phase 04 wraps both in one Mongo transaction. Until then, the window is a few milliseconds.

### Why not Redis locks (Redlock)?
| Option | Verdict |
|---|---|
| Atomic conditional update (chosen) | No new infrastructure, correct by Mongo's single-document atomicity |
| Redis distributed lock | Extra dependency, lock expiry edge cases, and the correctness of Redlock is debated (Kleppmann vs antirez) |
| Serialize through a queue partition | Correct, but turns a synchronous API into an async one — overkill here |

---

## 3. Fixes #2 and #3 — No Double Charge

Three layers, each catching what the previous one misses:

```text
 Layer 1  App check        Payment.findOne({ orderId }) exists?      → 400 "Order already paid"
 Layer 2  Stripe           idempotencyKey: `charge-${orderId}`        → Stripe returns the SAME charge
 Layer 3  Database         unique index on Payment.orderId             → second insert fails
```

- **Layer 1** handles the normal case (user clicks Pay twice, a few seconds apart).
- **Layer 2** handles concurrent requests that both pass layer 1. Stripe guarantees one charge per key for 24 hours.
- **Layer 3** makes sure there is never more than one `Payment` document per order.

The idempotency key is derived from `orderId`: a business rule says one order is paid at most once,
so the key follows naturally and no `Idempotency-Key` header from the client is needed.

### Code sketch — `payments/src/routes/new.ts`
```ts
const existingPayment = await Payment.findOne({ orderId });
if (existingPayment) {
    throw new BadRequestError("Order is already paid");
}

const charge = await stripe.charges.create(
    {
        currency: "usd",
        amount: Math.round(order.price * 100),
        source: token,
    },
    { idempotencyKey: `charge-${orderId}` }
);
```

Plus: `body("orderId").isMongoId()` validation, and `await` on the publish call.

`payments/src/models/payment.ts`: `orderId: { type: String, required: true, unique: true }`.

---

## 4. Fix #4 — Paid Orders Cannot Be Cancelled

`orders/src/routes/delete.ts`:
```ts
if (order.status === OrderStatus.Complete) {
    throw new BadRequestError("Cannot cancel a paid order");
}
if (order.status === OrderStatus.Cancelled) {
    return res.status(204).send(order);
}
```

The second check makes cancelling **idempotent**: cancelling twice doesn't publish a second `OrderCancelled`.

---

## 5. Fix #5 — Listener Errors Must Not Crash the Pod

Minimal fix in `common/src/events/base-listener.ts`. The full retry and DLQ design comes in Phase 03.

```ts
subscriptions.on("message", async (msg: Message) => {
    const parsedData = this.parseMessage(msg);
    try {
        await this.onMessage(parsedData, msg);
    } catch (err) {
        // Not acking = NATS redelivers after ackWait
        console.error(`Failed to process ${this.subject}`, err);
    }
});
```

---

## 6. Fixes #9 and #10 — Expiration Listener

```ts
const delay = Math.max(new Date(data.expiresAt).getTime() - Date.now(), 0);

await expirationQueue.add(
    { orderId: data.id },
    { delay, jobId: data.id }   // Bull ignores a job whose id already exists → idempotent
);
```

Using `jobId` turns Bull itself into the deduplication store. This is the first **idempotent consumer** in
the project, with no extra code.

Also in `expiration-queue.ts`: `await` the publish inside `process()`. Then Bull retries the job if publishing fails
(`attempts: 3, backoff: { type: "exponential", delay: 1000 }`).

---

## 7. Tests

| Test | File |
|---|---|
| Two concurrent `POST /api/orders` for one ticket → one 201, one 400 | `orders/src/routes/__test__/new.test.ts` |
| Cancelling an order releases `reservedBy` | `orders/src/routes/__test__/delete.test.ts` |
| Cancelling a complete order → 400 | `orders/src/routes/__test__/delete.test.ts` |
| `ticket-updated-listener` does **not** clear `reservedBy` | `orders/src/events/listeners/__test__/ticket-updated-listener.test.ts` |
| Second payment for the same order → 400 | `payments/src/routes/__test__/new.test.ts` |
| Stripe mock is called with `idempotencyKey` and a rounded amount | `payments/src/routes/__test__/new.test.ts` |
| Invalid `orderId` → 400 | `payments/src/routes/__test__/new.test.ts` |

The Stripe mock in [payments/src/__mocks__/stripe.ts](../payments/src/__mocks__/stripe.ts) must accept the second options argument.

---

## 8. Load Test Verification

| Scenario | Phase 00 result | Expected now |
|---|---|---|
| `flash-sale-race.js` (200 → 500 VUs, 1 ticket) | orders_created > 1 | **exactly 1** |
| `double-payment.js` (10 parallel) | payments_created > 1 | **exactly 1**, one charge in the Stripe dashboard |
| `consistency.ps1` — active orders per ticket | > 1 | **≤ 1** |

Record in `results/phase-02-correctness.md`.

---

## 9. Interview Angle

- **Check-then-act** (TOCTOU) races, and why "add a check" never fixes a race.
- **Atomic conditional writes** vs **pessimistic locks** vs **optimistic concurrency** (the `version` field already used here).
- **Defense in depth** for payments: app check → provider idempotency → DB constraint.
- **Idempotency keys**: who generates them, how long they live, why `orderId` is a natural key.
- Why an **unhandled promise rejection** in Node is a production outage.

---

## 10. Checklist

- [ ] Concept lesson written in `fixes/lessons/02-concurrency-and-race-conditions.md`, taught & discussed in detail, and explicit go-ahead signal received from developer
- [ ] `Ticket.reserve()` / `Ticket.release()` + `reservedBy` field in orders service
- [ ] `isReserved()` removed, routes + expiration listener updated
- [ ] Payments: existing-payment check, idempotency key, rounding, validation, unique index, awaited publish
- [ ] Delete route: cannot cancel complete orders, idempotent cancel
- [ ] Base listener: awaited + caught `onMessage` (common published)
- [ ] Tickets listener: awaited publish
- [ ] Expiration: clamped delay, `jobId`, awaited publish + Bull retries
- [ ] All tests pass, new tests added
- [ ] Load tests show exactly 1 order / 1 payment
- [ ] `notes/02-race-conditions-and-idempotency.md` written
