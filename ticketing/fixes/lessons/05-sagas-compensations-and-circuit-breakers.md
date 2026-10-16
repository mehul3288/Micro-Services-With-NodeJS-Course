# Phase 05: Payment Saga, Compensations & Circuit Breakers

> **Welcome to Phase 05!**
> In Phase 04, we made communication *within* each microservice rock-solid with the Transactional Outbox.
> Now in Phase 05, we tackle what happens **between** microservices when timing, external APIs, or network delays go wrong.

---

## 1. The Core Problems We Are Solving

| # | Real-World Scenario | Disaster It Causes | How We Solve It |
|---|---|---|---|
| **1** | **The Pay-at-Expiry Race:** User clicks "Pay" at 59.9s, expiration fires at 60.0s. | Order is cancelled, ticket is released to someone else, but Stripe took the customer's money! **Money stolen, no ticket.** | **Choreographed Saga with Compensating Refund** + 5s pre-expiry guard. |
| **2** | **Invalid State Overwrites:** Events arrive out of order or multiple times. | A `PaymentCreated` event flips an already-cancelled order back to `Complete`. | **Explicit Finite State Machine (`canTransition`)**. |
| **3** | **Lost Expiration Timer:** Redis crashes or a Bull queue job is lost. | Order stays in `Created` status forever, and the ticket is **locked forever** (can never be sold). | **Background Sweeper (Reconciliation Loop)**. |
| **4** | **Third-Party Outage (Stripe Slow):** Stripe takes 10s per call or is down. | Incoming HTTP requests hang, event loop fills up, pods crash. **Cascading failure**. | **Circuit Breaker Pattern (`opossum`)**. |

---

## 2. Deep Dive: The Pay-at-Expiry Race Condition

### The Bug in the Original Code:
Look at what happens on a timeline:

```text
Time (seconds) ────────────────────────────────────────────────────────────────────────►
Payments Pod:       59.5s: User submits token ──► Stripe charges card ($150) ✅
                                                        │
Expiration Pod:     60.0s: Expiration timer fires! ─────┼──► Order marked CANCELLED
                                                        │    Ticket released & sold to User B!
                                                        ▼
Orders Pod:         60.5s: PaymentCreated arrives...
                    orders/src/events/listeners/payment-created-listener.ts line 13:
                    order.set({ status: OrderStatus.Complete }); ❌
```

**The Disaster:**
- User A's order was cancelled at 60.0s. The ticket was released and purchased by User B.
- But at 60.5s, `PaymentCreatedListener` blindly overwrites `order.status = Complete`!
- Now **both User A and User B think they own the same ticket**, and User A was charged for an invalid order.

---

### The Solution: Prevention + Choreographed Compensation (Saga)

We fix this in two layers:

#### Layer 1: Prevention (Shrink the race window)
In `payments/src/routes/new.ts`:
- The payment route checks `order.expiresAt`.
- If the order expires in **less than 5 seconds**, we reject the request immediately:
  `400 Bad Request: "Order is about to expire, please create a new order"`.
- This eliminates 99% of near-expiration race conditions before charging Stripe.

#### Layer 2: Compensation (The Choreographed Saga)
What if a payment request started at 54.8s, but Stripe took 6 seconds to respond, so it completes at 60.8s?
This is where the **Saga** kicks in:

```text
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   THE CHOREOGRAPHED SAGA                                    │
│                                                                                             │
│  1. Orders Service: PaymentCreatedListener receives event                                   │
│     Is order.status === OrderStatus.Cancelled?                                              │
│        ├─ NO  ──► Normal Path: order.status = OrderStatus.Complete                          │
│        │                                                                                    │
│        └─ YES ──► Compensating Action!                                                      │
│                   DO NOT mark order Complete!                                               │
│                   Publish `RefundRequested` { orderId, paymentId, stripeId }                │
│                                      │                                                      │
│                                      ▼                                                      │
│  2. Payments Service: RefundRequestedListener                                               │
│     - Receives `RefundRequested`                                                            │
│     - Calls Stripe: `stripe.refunds.create({ charge }, { idempotencyKey: refund-${id} })`   │
│     - Updates Payment record: `status = "refunded"`                                         │
│     - Publishes `PaymentRefunded` event to Kafka                                            │
│                                      │                                                      │
│                                      ▼                                                      │
│  3. Client / Frontend UI:                                                                   │
│     Order status shows: "Order expired before payment completed. $150 has been refunded."   │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

> **Why is this called a Saga?**  
> In distributed microservices, you cannot do a database rollback across services.  
> A **Saga** is a sequence of local transactions. If one step fails, the system executes forward-looking **compensating transactions** to undo the business impact (e.g., refunding the card).

---

## 3. Strict State Transitions: The Finite State Machine

Currently, order statuses are mutated directly in various routes and listeners (`order.status = OrderStatus.Cancelled`, `order.status = OrderStatus.Complete`).

To prevent invalid transitions, we enforce a strict **Finite State Machine**:

```text
               ┌───────────┐
               │  Created  │
               └─────┬─────┘
                     │
         ┌───────────┴───────────┐
         ▼                       ▼
   ┌───────────┐           ┌───────────┐
   │ Complete  │           │ Cancelled │
   └───────────┘           └─────┬─────┘
                                 │
                                 ▼ (via Saga Compensation)
                           ┌───────────┐
                           │ Refunded  │
                           └───────────┘
```

### The Rules of the Matrix:
| From \ To | `Created` | `AwaitingPayment` | `Complete` | `Cancelled` |
|---|---|---|---|---|
| **`Created`** | ❌ No | ✅ Yes | ✅ Yes | ✅ Yes |
| **`AwaitingPayment`** | ❌ No | ❌ No | ✅ Yes | ✅ Yes |
| **`Complete`** | ❌ No | ❌ No | ❌ No | ❌ **NEVER** |
| **`Cancelled`** | ❌ No | ❌ No | ❌ **NEVER** | ❌ No |

If any code attempts `Cancelled -> Complete`, the state machine helper `canTransition(from, to)` throws an explicit error, preventing state corruption.

---

## 4. The Sweeper: Reconciliation Loop

What happens if Redis crashes, or a developer runs `redis-cli FLUSHALL`, or an expiration job is dropped?
The order would stay `status: "created"` forever, and the ticket's `reservedBy` would **never be released**!

### The Golden Rule of Distributed Systems:
> **"Events for speed, reconciliation for correctness."**

Events provide sub-second reaction times during normal operation.  
A **Sweeper** is a safety net running periodically in the background:

```text
Every 30 seconds:
┌─────────────────────────────────────────────────────────────┐
│                 Sweeper Job (Orders Service)                │
│                                                             │
│  1. Acquires leader lease (`sweeper-lease`)                 │
│  2. Finds all orders where:                                 │
│     - status === OrderStatus.Created                        │
│     - expiresAt < new Date()                                │
│  3. For each stale order:                                   │
│     - Cancels order                                         │
│     - Releases ticket reservation                           │
│     - Publishes `OrderCancelled` to Kafka via Outbox        │
└─────────────────────────────────────────────────────────────┘
```
If 100 expiration events are lost due to a Redis failure, the Sweeper automatically cleans them up within 30 seconds!

---

## 5. Circuit Breaker for Stripe: Preventing Cascading Failure

When your service calls a 3rd-party API like Stripe:
- If Stripe is experiencing degraded performance (taking 10–15 seconds per call), every incoming user request blocks waiting on Stripe.
- Node.js event loop gets overwhelmed with thousands of open TCP sockets.
- The `payments` pod runs out of memory or hits Kubernetes liveness probe timeouts and restarts.
- **Cascading failure:** The entire payments service goes down.

### The Circuit Breaker Pattern:

```text
            Normal (Low Failures)
          ┌─────────────────────────┐
          │         CLOSED          │ ──► All requests go through to Stripe
          └────────────┬────────────┘
                       │
                       │ 5 consecutive timeouts or 50% failures
                       ▼
          ┌─────────────────────────┐
          │          OPEN           │ ──► Immediately fails fast (HTTP 503)
          └────────────┬────────────┘     WITHOUT calling Stripe! (Saves your pods)
                       │
                       │ After 10s cooldown
                       ▼
          ┌─────────────────────────┐
          │        HALF-OPEN        │ ──► Lets 1 canary request through
          └────────────┬────────────┘
                       │
             ┌─────────┴─────────┐
        Success?               Failed?
             ▼                     ▼
          CLOSED                 OPEN
```

### Critical Rule for Breakers: Business Errors vs. Infrastructure Errors
- **Timeout / 500 / Network ECONNREFUSED:** 🚨 **Trips the breaker!** (Stripe is down).
- **Card Declined / Insufficient Funds / Invalid CVC:** ✅ **DOES NOT trip the breaker!** (Stripe is working perfectly; the user just entered a bad card).

---

## 6. What We Will Build in Phase 05:

1. **New Events in `@mehul-mrtickets/common`:**
   - `RefundRequested` (Topic: `order-events`, Key: `ticket.id`)
   - `PaymentRefunded` (Topic: `payment-events`, Key: `orderId`)
   - `PaymentStatus` enum (`succeeded`, `refunded`)
   - `ServiceUnavailableError` (HTTP 503)
2. **Order State Machine:**
   - `orders/src/models/order-transitions.ts` enforcing valid state transitions.
   - Refactored `cancelOrder` service used by both `delete` route and `expiration` listener.
3. **The Saga Implementation:**
   - `orders`: `PaymentCreatedListener` checks if order was cancelled. If cancelled -> publishes `RefundRequested`.
   - `payments`: 5-second expiration guard on `POST /api/payments`.
   - `payments`: `RefundRequestedListener` calls Stripe refund with idempotency key, marks payment `refunded`, and publishes `PaymentRefunded`.
4. **The Sweeper:**
   - Background cron in `orders` running every 30s with `Lease` lock, cleaning up any expired orders that missed their event.
5. **The Circuit Breaker:**
   - Wrapping Stripe charge & refund calls with `opossum` circuit breaker.

---

### Questions to Consider Before We Start:
1. Does the flow between `PaymentCreated` ➔ `RefundRequested` ➔ `PaymentRefunded` make complete sense?
2. Do you have any questions on why we reject orders with $<5$ seconds remaining before calling Stripe?

Whenever you are ready, give the go-ahead and we will begin implementing Phase 05 step-by-step!
