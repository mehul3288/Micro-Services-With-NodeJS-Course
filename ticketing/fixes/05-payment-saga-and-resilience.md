# Phase 05 — Payment Saga & Resilience

**Goal:** Handle what happens *between* services when timing goes wrong (payment vs expiry), make sure no order
stays stuck forever, and make sure a slow Stripe can't take the payments service down with it.

**Grouped because:** all of this is about the **order → payment lifecycle** and its failure modes.
The circuit breaker wraps the same Stripe calls that the saga's refund uses.

---

## 1. Problems

| # | Problem | Impact |
|---|---|---|
| 1 | **Pay-at-expiry race**: the user pays at 59.9s, expiration fires at 60s | Customer charged, order cancelled, ticket resold. **Money taken, no ticket.** |
| 2 | Order status rules are spread across routes and listeners | Easy to add an invalid transition (e.g. cancelled → complete) |
| 3 | If an expiry job is lost (Redis crash in the ~1s AOF window, a bug, a manual flush) | Order stays `created` forever and the **ticket is locked forever** |
| 4 | Stripe slow or down → every payment request hangs for the full timeout | Node event loop fills with waiting requests, pods look dead, **cascading failure** |
| 5 | Charge succeeded but the pod crashed before saving, and the client never retries | Orphan charge with no Payment record |

---

## 2. The Pay-at-Expiry Race

```text
 time ─────────────────────────────────────────────────────────────────────►
 Payments:  receives POST /api/payments ── Stripe charge ✅ ── PaymentCreated ──┐
 Expiration:                        ExpirationComplete ──┐                    │
 Orders:                                    order → CANCELLED, OrderCancelled │
                                                                              ▼
 Orders:                                    PaymentCreated arrives... order is already cancelled 🤷
```

Today `PaymentCreatedListener` sets the order to `complete` **without checking its state**
([payment-created-listener.ts](../orders/src/events/listeners/payment-created-listener.ts) line 15). So a cancelled
order becomes "complete" while its ticket has already been released. That's a double sale.

### Fix = prevention + compensation (a choreographed saga)

**Prevention** (shrinks the window):
- Payments' `Order` replica stores `expiresAt` (already in `OrderCreatedEvent`).
- `POST /api/payments` rejects orders that expire within the next 5 seconds: `"Order is about to expire"`.

**Compensation** (handles what's left of the window):
```text
 Orders: PaymentCreatedListener
    order.status === cancelled ?
       ├─ no  → order → complete                                  (happy path)
       └─ yes → publish RefundRequested { orderId, paymentId }      (compensating action)
                         │
                         ▼
 Payments: RefundRequestedListener
    stripe.refunds.create({ charge }, { idempotencyKey: `refund-${paymentId}` })
    payment.status → refunded
    publish PaymentRefunded { paymentId, orderId }
                         │
                         ▼
 Client: order page shows "Your order expired before payment completed. You have been refunded."
```

Each step is a local transaction + outbox publish (Phase 04). The refund is idempotent, so redelivery can never refund twice.

### Choreography vs orchestration
| | Choreography (chosen) | Orchestration |
|---|---|---|
| How | Services react to each other's events | A central orchestrator (e.g. Temporal) tells services what to do |
| Fits when | Few steps, few services, as here | Many steps, complex branching, need for a visible workflow state |
| Downside | The flow is spread out, harder to see as a whole | Extra component, central coupling |

With two services and one compensation, choreography is the right size. Be ready to explain when you would switch.

---

## 3. Order State Machine

One small file defines all legal transitions, so invalid ones are impossible to write by accident.

`orders/src/models/order-transitions.ts`:
```ts
import { OrderStatus } from "@mehul-mrtickets/common";

const allowedTransitions: Record<OrderStatus, OrderStatus[]> = {
    [OrderStatus.Created]: [OrderStatus.AwaitingPayment, OrderStatus.Complete, OrderStatus.Cancelled],
    [OrderStatus.AwaitingPayment]: [OrderStatus.Complete, OrderStatus.Cancelled],
    [OrderStatus.Complete]: [],
    [OrderStatus.Cancelled]: []
};

export const canTransition = (from: OrderStatus, to: OrderStatus) => {
    return allowedTransitions[from].includes(to);
};
```

```text
             ┌──────────────► complete   (terminal)
   created ──┤
             └──────────────► cancelled  (terminal)  ──► late payment? → refund
```

`PaymentCreatedListener`, `ExpirationCompleteListener`, the delete route and the sweeper all check `canTransition`
before changing status.

### Concurrent events on one order
`PaymentCreated` (payment-events) and `ExpirationComplete` (expiration-events) are on different topics, so they can be
processed at the same moment. The existing **optimistic concurrency** (`version` in the `pre("save")` hook)
makes one save fail with a `VersionError`. The consumer retries (Phase 03), re-reads the order, and the state machine
picks the right branch. No new code is needed. This is a good example of OCC paying off.

---

## 4. Expiry Sweeper (Safety Net)

### Extract shared logic first
Cancelling an order currently lives in two places (delete route, `ExpirationCompleteListener`), and the sweeper
would add a third. It moves into one function:

`orders/src/services/cancel-order.ts`:
```ts
export const cancelOrder = async (order: OrderDoc, session: ClientSession) => {
    if (!canTransition(order.status, OrderStatus.Cancelled)) {
        return;
    }

    order.set({ status: OrderStatus.Cancelled });
    await order.save({ session });
    await Ticket.release(order.ticket.id, order.id, session);

    await new OrderCancelledPublisher().publish({
        id: order.id,
        version: order.version,
        ticket: { id: order.ticket.id }
    }, session);
};
```

### The sweeper
`orders/src/jobs/expire-orders-sweeper.ts`:
```text
every 60s (only on the replica holding the "expire-orders-sweeper" lease from Phase 04):
   orders = find({ status: created, expiresAt < now - 30s }).limit(100)
   for each: transaction → cancelOrder(order, session)
   log how many were swept   ← should normally be 0
```

- The **30s grace period** lets the normal path (Bull → ExpirationComplete) win in the common case.
- If the sweeper and `ExpirationComplete` both fire, `canTransition` + OCC make the second one a no-op.
- The expiration service stays the **fast, precise** path. The sweeper is the **slow, guaranteed** one.
  This "fast path + reconciliation loop" pattern is used everywhere in real systems.

`EXPIRATION_WINDOW_SECONDS` in [orders/src/routes/new.ts](../orders/src/routes/new.ts) moves to the env var
`ORDER_EXPIRATION_SECONDS` so tests can use short windows.

---

## 5. Circuit Breaker for Stripe

### Without a breaker
```text
Stripe hangs → every request waits 80s (Stripe default) → event loop full of pending requests
→ health checks time out → Kubernetes restarts pods → the outage spreads to us
```

### With a breaker (opossum)
```text
         failures ≥ 50% of the last N calls
 CLOSED ───────────────────────────────────────► OPEN ──── fail instantly with 503 (no Stripe call)
   ▲                                               │
   │ trial call succeeds                           │ after 30s
   └─────────────────── HALF-OPEN ◄────────────────┘
                       (let 1 call through)
```

`payments/src/services/stripe-client.ts`:
```ts
const chargeBreaker = new CircuitBreaker(createCharge, {
    timeout: 5000,
    errorThresholdPercentage: 50,
    volumeThreshold: 5,
    resetTimeout: 30 * 1000,
    // Card declines are business errors, not Stripe being unhealthy
    errorFilter: (err) => err.type === "StripeCardError"
});

export const chargeCard = (params: ChargeParams, idempotencyKey: string) => {
    return chargeBreaker.fire(params, idempotencyKey);
};
```

- Same pattern for `refundCharge` (used by the saga).
- Stripe client: `new Stripe(key, { timeout: 5000, maxNetworkRetries: 2 })`. Retries are safe because of the idempotency key.
- Breaker open → new `ServiceUnavailableError` in common (HTTP **503**, "Payment provider unavailable, please retry").
- The route calls `chargeCard(...)` instead of `stripe.charges.create(...)` and otherwise stays the same.

### Refunds when the breaker is open
`RefundRequestedListener` throws → consumer retries → DLQ after 3 attempts. The refund is **not lost**: it waits in the
DLQ and is replayed when Stripe recovers (Phase 06 alerts on it). Losing a refund is unacceptable, so a slow refund is
the right trade-off.

---

## 6. Stretch: Stripe Webhook Reconciliation (Problem #5)

`POST /api/payments/webhook` handles `charge.succeeded`. If no `Payment` exists for the charge's `orderId` (in metadata),
it creates one and publishes `PaymentCreated`. This makes **Stripe the source of truth** for money.
Local testing: `stripe listen --forward-to https://ticketing.dev/api/payments/webhook`.
Marked as stretch because it needs the Stripe CLI and a signing secret. Worth doing if time allows.

---

## 7. New Events (common)

| Event | Topic | Key | Data |
|---|---|---|---|
| `RefundRequested` | `order-events` | `ticket.id` | `{ orderId, paymentId, reason }` |
| `PaymentRefunded` | `payment-events` | `orderId` | `{ paymentId, orderId }` |

`Payment` model gains `status: "succeeded" | "refunded"`.

---

## 8. Tests

| Test | Where |
|---|---|
| `canTransition` table (all pairs) | `orders/src/models/__test__/order-transitions.test.ts` |
| PaymentCreated on a cancelled order → `RefundRequested` outbox row, status unchanged | orders listener test |
| PaymentCreated on a created order → complete | orders listener test |
| Sweeper cancels only stale `created` orders and releases tickets | `orders/src/jobs/__test__/` |
| Payment rejected if the order expires within 5s | payments route test |
| RefundRequested → Stripe refund called with idempotency key, status refunded | payments listener test |
| Breaker opens after failures → 503 without calling Stripe | payments `services/__test__/` |
| Card decline does **not** open the breaker | same |

---

## 9. Verification

| Scenario | How | Expected |
|---|---|---|
| Pay-at-expiry | New `load-tests/scenarios/pay-at-expiry.js`: `ORDER_EXPIRATION_SECONDS=15`, pay at 14–16s with jitter, 100 orders | Every charge belongs to a **complete** order or is **refunded**. 0 "charged + cancelled" in `consistency.ps1` |
| Lost expiry jobs | Create 50 orders → `redis-cli FLUSHALL` → wait | All 50 cancelled by the sweeper within ~90s, tickets released |
| Stripe outage | Point the Stripe client `host` at an unroutable address via env | First calls time out at 5s, then **instant 503s** (record latency before/after the breaker opens); orders pod stays healthy |
| Stripe recovery | Restore host | Breaker half-opens, then closes; DLQ refunds replayed successfully |

Record in `results/phase-05-saga-resilience.md`.

---

## 10. Interview Angle

- **Sagas**: why there is no distributed transaction across services; compensating actions instead of rollback.
- **Choreography vs orchestration**, and when to bring in Temporal or Step Functions.
- **Prevention + compensation**: shrink the race window, then handle what's left.
- **Reconciliation loops** (sweeper, webhooks) as the backbone of reliable systems: "events for speed, reconciliation for correctness".
- **Circuit breaker states**, why business errors must not trip it, and timeouts as the first line of defense.
- **Why refunds go to the DLQ instead of being dropped**: money operations must be durable, even if slow.

---

## 11. Checklist

- [ ] Concept lesson written in `fixes/lessons/05-sagas-compensations-and-circuit-breakers.md`, taught & discussed in detail, and explicit go-ahead signal received from developer
- [ ] `order-transitions.ts` + used everywhere status changes
- [ ] `services/cancel-order.ts` extracted; delete route + expiration listener use it
- [ ] PaymentCreatedListener compensation → `RefundRequested`
- [ ] Payments: `expiresAt` on replica, 5s guard, `RefundRequestedListener`, `Payment.status`
- [ ] `RefundRequested` / `PaymentRefunded` events in common
- [ ] Expiry sweeper with lease; `ORDER_EXPIRATION_SECONDS` env var
- [ ] Circuit breaker for charge + refund, `ServiceUnavailableError` in common
- [ ] Client shows refunded state on the order page
- [ ] (Stretch) Stripe webhook reconciliation
- [ ] Tests + verification complete, results recorded
- [ ] `notes/05-sagas-and-resilience.md` written
