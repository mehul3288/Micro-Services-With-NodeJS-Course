# Phase 05 Notes — Payment Saga & Resilience

## 1. Architectural Motivation: The Pay-at-Expiry Race

In distributed systems, operations across multiple services and third-party APIs have latency:
```text
Order Created (60s timer) ────────────────────────────────────────────────────────► Expiration (60s)
                                              ▲
                                              │ User pays at 58s
                                              ▼
                                   Stripe Network Latency (3-5s)
                                              ▼
                                   Payment succeeds at 63s!
```
Without coordination:
1. At 60s, Expiration Service marks the order `Cancelled` and releases the ticket.
2. Another customer reserves or buys that free ticket.
3. At 63s, Stripe succeeds in charging customer 1, and `payments` publishes `payment:created`.
4. `orders` receives `payment:created` and blindly updates the order to `Complete`.
5. **Catastrophic Failure:** The same ticket has been sold twice, and customer 1 has been charged for an order whose ticket now belongs to someone else.

---

## 2. The Solution: Two-Layer Defense (Prevention + Compensation)

### Layer 1: Prevention (< 5s Pre-Expiry Guard)
In `POST /api/payments`:
```typescript
if (order.expiresAt && order.expiresAt.getTime() - Date.now() < 5000) {
    throw new BadRequestError("Order has expired or is about to expire, please re-order");
}
```
* If a customer submits payment with less than 5 seconds remaining before expiration, we immediately reject the HTTP request with `400 Bad Request`.
* We **never call Stripe**. No money leaves their card, and the race is prevented 99% of the time.

### Layer 2: Compensation (Choreographed Refund Saga)
If an order had 7 seconds left (passing the 5s guard) but Stripe suffered network latency and completed after the order expired:
1. `orders/PaymentCreatedListener` checks `canTransition(order.status, OrderStatus.Complete)`.
2. Detecting `order.status === Cancelled`, it refuses to complete the order.
3. Instead, it writes a **`RefundRequested`** event (`{ orderId, paymentId, reason }`) to the Transactional Outbox.
4. `payments/RefundRequestedListener` consumes `RefundRequested`, calls `stripe.refunds.create({ charge: payment.stripeId }, { idempotencyKey: refund-${payment.id} })`.
5. Updates `payment.status = "refunded"` and writes **`PaymentRefunded`** to the Outbox.
6. The customer is automatically refunded, and the ticket remains safely with the rightful buyer.

---

## 3. Order Finite State Machine

All legal state transitions are centralized in `orders/src/models/order-transitions.ts`:
```typescript
const allowedTransitions: Record<OrderStatus, OrderStatus[]> = {
    [OrderStatus.Created]: [OrderStatus.AwaitingPayment, OrderStatus.Complete, OrderStatus.Cancelled],
    [OrderStatus.AwaitingPayment]: [OrderStatus.Complete, OrderStatus.Cancelled],
    [OrderStatus.Complete]: [],
    [OrderStatus.Cancelled]: [],
};
```
* Terminal states (`Complete`, `Cancelled`) cannot transition into any other state.
* `cancelOrder` service centralizes cancellation and ticket release logic across the `delete` route, `ExpirationCompleteListener`, and the background sweeper.

---

## 4. Background Expiry Sweeper (Safety Net Reconciliation Loop)

If an expiration event is lost (e.g. Redis crash, network partition, or manual flush), orders would remain in `Created` status and tickets locked forever.

**The Sweeper (`orders/src/jobs/expire-orders-sweeper.ts`):**
* Runs every 60s in the background.
* Acquires a distributed leader `Lease` from MongoDB (`expire-orders-sweeper`) so only one pod replica sweeps.
* Scans for orders with `status: Created` and `expiresAt < now - 30s` (30s grace period allows Bull Redis fast-path to win normally).
* Cancels stale orders, releases tickets, and publishes `OrderCancelled` via Outbox.

---

## 5. Stripe Circuit Breaker (`opossum`)

Wrapping external third-party calls (`stripe.charges.create` and `stripe.refunds.create`) protects the microservice from cascading failures:
* **Timeout:** 5000ms.
* **Volume Threshold:** 5 calls.
* **Error Threshold Percentage:** 50%.
* **Reset Timeout:** 30 seconds.
* **Error Filter:** Business errors (such as `StripeCardError` for card declines or `StripeInvalidRequestError`) are filtered out and do **not** trip the breaker.
* **Fast Failure:** When Stripe is unreachable, repeated infrastructure errors trip the breaker to `OPEN`. All subsequent payment requests fail fast immediately with `ServiceUnavailableError` (HTTP 503) without saturating the Node.js event loop.

---

## 6. Summary of Test Results

| Microservice | Test Suites | Tests Passed | Tests Failed |
|---|---|---|---|
| `orders` | 10 / 10 | 29 | 0 |
| `payments` | 5 / 5 | 17 | 0 |
| `tickets` | 7 / 7 | 23 | 0 |
| `auth` | 4 / 4 | 12 | 0 |
| **Total** | **26 / 26** | **81** | **0** |
