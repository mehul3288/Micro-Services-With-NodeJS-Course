# Phase 05: Complete Code & Architecture Walkthrough (Payment Saga, State Machines & Circuit Breakers)

> **Purpose of this guide:**
> In Phase 05, we solved the most critical business and timing bugs that emerge between microservices: the **Pay-at-Expiry race condition**, **double selling**, **cascading third-party failures**, and **silent data corruption**.
> This document is your **single, self-contained reference**. You do **not** need to hunt across directories: every concept, exact line of code, finite state machine table, choreographed saga flow, and circuit breaker configuration is explained step-by-step.

---

## 1. The Big Picture: What Problem Did We Solve?

### 1.1 The Double-Sale Disaster Before Phase 05

In the original application, payment and expiration operated without coordination:

```text
Time (s):   0s ──────────────────────── 58s ─── 60s ─── 61s ─────────── 63s ──────── 64s
             │                           │       │       │                │           │
User 1:   Creates Order 1                │       │       │                │           │
          (60s timer starts)             │       │       │                │           │
          Ticket locked                  │       │       │                │           │
                                         ▼       │       │                │           │
User 1:                             Clicks Pay   │       │                │           │
                                    (calls Stripe)       │                │           │
                                                 ▼       │                │           │
Expiration Service:                         Timer fires! │                │           │
                                            Order 1 CANCELLED             │           │
                                            Ticket RELEASED               │           │
                                                         ▼                │           │
User 2:                                             Buys Ticket!          │           │
                                                    Order 2 CREATED       │           │
                                                                          ▼           │
Stripe:                                                             Charge succeeds!  │
                                                                    (took 5 seconds)  │
                                                                                      ▼
Orders Service:                                                         PaymentCreated arrives...
                                                                        Blindly sets Order 1
                                                                        to COMPLETE!
```

#### What went wrong?
1. **Double Sale:** Both Customer 1 (Order 1) and Customer 2 (Order 2) have an order marked `Complete` for the exact same ticket seat.
2. **Customer Robbery:** Customer 1 had money deducted from their bank card, but their seat was already given to Customer 2.
3. **State Corruption:** Order 1 was transitioned from `Cancelled` to `Complete`.

---

### 1.2 The Solution: Two-Layer Defense (Prevention + Choreographed Saga)

```text
                                  Customer clicks "Pay"
                                           │
                                           ▼
                       ┌───────────────────────────────────────┐
                       │    LAYER 1: PRE-EXPIRY GUARD (< 5s)   │
                       │   Is order.expiresAt - now < 5000ms?  │
                       └───────────────────┬───────────────────┘
                                           │
                          ┌────────────────┴────────────────┐
                          │ YES                             │ NO
                          ▼                                 ▼
                 REJECT IMMEDIATELY                  Call Stripe API
                 HTTP 400 Bad Request               (via Circuit Breaker)
                 "Order about to expire"                    │
                 (Card NEVER charged!)                      ▼
                                                    Payment succeeded!
                                                            │
                                                            ▼
                                               Orders: PaymentCreatedListener
                                                            │
                                                            ▼
                                               ┌─────────────────────────┐
                                               │  Is order.status ===    │
                                               │        Cancelled?       │
                                               └────────────┬────────────┘
                                                            │
                                      ┌─────────────────────┴─────────────────────┐
                                      │ NO (Happy Path)                           │ YES (Late Payment Race)
                                      ▼                                           ▼
                           Order ➔ COMPLETE                              Refuse transition!
                           Ticket owned by User                          LAYER 2: SAGA COMPENSATION
                                                                         Publish RefundRequested
                                                                                   │
                                                                                   ▼
                                                                     Payments: RefundRequestedListener
                                                                     stripe.refunds.create({ charge })
                                                                     payment.status ➔ REFUNDED
                                                                     Publish PaymentRefunded
                                                                                   │
                                                                                   ▼
                                                                     Customer automatically refunded!
```

---

## 2. The Mental Model: Real-World Analogy

Think of this like an **Airport Boarding Gate**:

| Architectural Role | Who is it in code? | Airport Gate Analogy | Responsibility |
|---|---|---|---|
| **Pre-Expiry Guard** | `order.expiresAt - now < 5000` | **"Doors Close 10 Mins Before Departure"** | Even if the plane hasn't pushed back yet, the gate attendant stops anyone from scanning their boarding pass under 10 minutes to prevent runway chaos. |
| **State Machine** | `canTransition(from, to)` | **One-Way Turnstiles** | You can walk from the terminal onto the jet bridge, but you can never walk backwards from the baggage claim back onto the airplane. |
| **Choreographed Saga** | `RefundRequested` ➔ `PaymentRefunded` | **Baggage Return Voucher** | If you accidentally board a canceled flight, the system automatically pulls your luggage off and refunds your ticket balance without manual disputes. |
| **Circuit Breaker** | `opossum` (`chargeBreaker`) | **Terminal Gate Closure during Storm** | If the runway radar is down, airport operations halts boarding immediately (503) instead of letting 1,000 passengers pile into the tunnel waiting indefinitely. |
| **Expiry Sweeper** | `ExpireOrdersSweeper` | **Nightly Tarmac Inspection** | If a passenger pass was dropped on the floor and never logged, the nightly sweep cleans up the seat and marks it open for tomorrow. |

---

## 3. Layer 1: `@mehul-mrtickets/common@3.1.0` Additions

All microservices need shared type definitions for saga events, status enums, and HTTP error codes.

### 3.1 New Error: `ServiceUnavailableError` (HTTP 503)
File: [common/src/errors/service-unavailable-error.ts](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/common/src/errors/service-unavailable-error.ts)

When Stripe is down or our Circuit Breaker is `OPEN`, we must return HTTP **503** (not 500 or 400). HTTP 503 tells clients and ingress proxies: *"The server is fine, but an upstream dependency is temporarily unavailable; retry with backoff."*

```typescript
import { CustomError } from "./custom-error";

export class ServiceUnavailableError extends CustomError {
    statusCode = 503;

    constructor(message: string = "Service temporarily unavailable, please retry later") {
        super(message);
        Object.setPrototypeOf(this, ServiceUnavailableError.prototype);
    }

    serializeError() {
        return [{ message: this.message }];
    }
}
```

---

### 3.2 Saga Compensation Events
File: [common/src/events/refund-requested-event.ts](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/common/src/events/refund-requested-event.ts)
```typescript
import { Subjects } from "./subjects";

export interface RefundRequestedEvent {
    subject: Subjects.RefundRequested; // "order:refund-requested"
    data: {
        orderId: string;
        paymentId: string;
        reason?: string;
    };
}
```

File: [common/src/events/payment-refunded-event.ts](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/common/src/events/payment-refunded-event.ts)
```typescript
import { Subjects } from "./subjects";

export interface PaymentRefundedEvent {
    subject: Subjects.PaymentRefunded; // "payment:refunded"
    data: {
        paymentId: string;
        orderId: string;
        stripeRefundId?: string;
    };
}
```

File: [common/src/events/types/payment-status.ts](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/common/src/events/types/payment-status.ts)
```typescript
export enum PaymentStatus {
    Succeeded = "succeeded",
    Refunded = "refunded",
}
```

---

### 3.3 Subject & Topic Routing Table
File: [common/src/events/topics.ts](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/common/src/events/topics.ts)

`RefundRequested` originates in `orders` (topic `order-events`), while `PaymentRefunded` originates in `payments` (topic `payment-events`):
```typescript
export const topicFor: Record<Subjects, Topics> = {
    [Subjects.TicketCreated]: Topics.TicketEvents,
    [Subjects.TicketUpdated]: Topics.TicketEvents,
    [Subjects.OrderCreated]: Topics.OrderEvents,
    [Subjects.OrderCancelled]: Topics.OrderEvents,
    [Subjects.PaymentCreated]: Topics.PaymentEvents,
    [Subjects.ExpirationComplete]: Topics.ExpirationEvents,
    [Subjects.RefundRequested]: Topics.OrderEvents,     // <── Saga step 1
    [Subjects.PaymentRefunded]: Topics.PaymentEvents,   // <── Saga step 2
};
```

---

## 4. Layer 2: `orders` Service (State Machine & Saga Trigger)

### 4.1 Order Finite State Machine
File: [orders/src/models/order-transitions.ts](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/orders/src/models/order-transitions.ts)

State transitions must be deterministic. By expressing legal transitions as an adjacency table, invalid status updates become impossible.

```typescript
import { OrderStatus } from "@mehul-mrtickets/common";

const allowedTransitions: Record<OrderStatus, OrderStatus[]> = {
    [OrderStatus.Created]: [
        OrderStatus.AwaitingPayment,
        OrderStatus.Complete,
        OrderStatus.Cancelled,
    ],
    [OrderStatus.AwaitingPayment]: [
        OrderStatus.Complete,
        OrderStatus.Cancelled,
    ],
    [OrderStatus.Complete]: [],   // Terminal state: cannot transition to anything
    [OrderStatus.Cancelled]: [],  // Terminal state: cannot transition to anything
};

export const canTransition = (from: OrderStatus, to: OrderStatus): boolean => {
    return allowedTransitions[from]?.includes(to) ?? false;
};
```

#### Why are `Complete` and `Cancelled` empty arrays?
* Once an order is `Complete`, no user cancellation, expiration event, or refund request can move it back to `Created` or `Cancelled`.
* Once an order is `Cancelled`, a late-arriving payment can **never** resurrect it into `Complete`.

---

### 4.2 Shared Cancellation Service: `cancelOrder`
File: [orders/src/services/cancel-order.ts](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/orders/src/services/cancel-order.ts)

Before Phase 05, order cancellation logic was duplicated across the DELETE route and the expiration listener, leading to drift. We unified it into a single atomic service:

```typescript
import { ClientSession } from "mongoose";
import { OrderStatus } from "@mehul-mrtickets/common";
import { OrderDoc } from "../models/order";
import { Ticket } from "../models/ticket";
import { OrderCancelledPublisher } from "../events/publishers/order-cancelled-publisher";
import { canTransition } from "../models/order-transitions";

export const cancelOrder = async (order: OrderDoc, session?: ClientSession): Promise<boolean> => {
    // 1. Guard against invalid transitions
    if (!canTransition(order.status, OrderStatus.Cancelled)) {
        return false;
    }

    const ticketId = typeof order.ticket === "object" && order.ticket !== null
        ? order.ticket.id
        : String(order.ticket);

    // 2. Release the atomic reservation in the Ticket replica
    if (ticketId) {
        await Ticket.release(ticketId, order.id, session);
    }

    // 3. Mark the Order document Cancelled
    order.set({ status: OrderStatus.Cancelled });
    await order.save({ session });

    // 4. Atomically write OrderCancelledEvent to the Transactional Outbox
    await new OrderCancelledPublisher().publish({
        id: order.id,
        version: order.version,
        ticket: {
            id: ticketId,
        },
    }, session);

    return true;
};
```

---

### 4.3 Saga Compensation in `PaymentCreatedListener`
File: [orders/src/events/listeners/payment-created-listener.ts](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/orders/src/events/listeners/payment-created-listener.ts)

This listener receives `payment:created` when Stripe charges a customer. Here is where we catch the late payment race:

```typescript
import { EventMetadata, Listener, OrderStatus, PaymentCreatedEvent, Subjects } from "@mehul-mrtickets/common";
import { Order } from "../../models/order";
import { canTransition } from "../../models/order-transitions";
import { RefundRequestedPublisher } from "../publishers/refund-requested-publisher";

export class PaymentCreatedListener extends Listener<PaymentCreatedEvent> {
    readonly subject: Subjects.PaymentCreated = Subjects.PaymentCreated;

    async onMessage(data: PaymentCreatedEvent["data"], metadata: EventMetadata): Promise<void> {
        const order = await Order.findById(data.orderId).session(metadata.session || null);
        if (!order) {
            throw new Error("Order not found");
        }

        // LATE PAYMENT RACE DETECTION:
        // If order already expired and is Cancelled, we MUST NOT set it to Complete!
        if (order.status === OrderStatus.Cancelled) {
            // Trigger compensating saga action via Transactional Outbox:
            await new RefundRequestedPublisher().publish({
                orderId: order.id,
                paymentId: data.id,
                reason: "Order expired or was cancelled before payment completed",
            }, metadata.session);
            return;
        }

        // Check finite state machine for legal transition
        if (!canTransition(order.status, OrderStatus.Complete)) {
            return;
        }

        order.set({
            status: OrderStatus.Complete,
        });
        await order.save({ session: metadata.session });
    }
}
```

---

### 4.4 The Expiry Sweeper (Reconciliation Safety Net)
File: [orders/src/jobs/expire-orders-sweeper.ts](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/orders/src/jobs/expire-orders-sweeper.ts)

What if Redis crashes, Bull queue loses a delayed job, or an operator runs `FLUSHALL`? Without a sweeper, an order would sit in `Created` forever, and its ticket would be locked forever.

The sweeper is our **slow, guaranteed reconciliation loop**:

```typescript
import mongoose from "mongoose";
import { acquireLease, OrderStatus } from "@mehul-mrtickets/common";
import { Order } from "../models/order";
import { cancelOrder } from "../services/cancel-order";

export class ExpireOrdersSweeper {
    private timer?: NodeJS.Timeout;
    private running = false;
    private readonly instanceId = `${process.pid}-${Math.random().toString(36).substring(2, 9)}`;

    constructor(
        private pollIntervalMs = 60000,
        private gracePeriodMs = 30000 // 30s grace period allows Bull fast path to win
    ) {}

    start(): void {
        this.running = true;
        this.scheduleNext();
    }

    stop(): void {
        this.running = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }

    async sweep(): Promise<number> {
        // Multi-pod leader election: only the replica holding the lease performs the sweep
        const hasLease = await acquireLease("expire-orders-sweeper", this.instanceId, 30000);
        if (!hasLease) {
            return 0;
        }

        // Cutoff: only orders that expired MORE than gracePeriodMs ago
        const cutoff = new Date(Date.now() - this.gracePeriodMs);
        const expiredOrders = await Order.find({
            status: OrderStatus.Created,
            expiresAt: { $lt: cutoff },
        }).populate("ticket").limit(100);

        let sweptCount = 0;
        for (const order of expiredOrders) {
            try {
                await mongoose.connection.transaction(async (session) => {
                    const cancelled = await cancelOrder(order, session);
                    if (cancelled) {
                        sweptCount++;
                    }
                });
            } catch (err) {
                console.error(`[ExpireOrdersSweeper] Failed to sweep order ${order.id}:`, err);
            }
        }

        if (sweptCount > 0) {
            console.log(`[ExpireOrdersSweeper] Swept and cancelled ${sweptCount} expired orders`);
        }

        return sweptCount;
    }
}
```

---

## 5. Layer 3: `payments` Service (Guards & Circuit Breaker)

### 5.1 `< 5s` Pre-Expiry Guard in `POST /api/payments`
File: [payments/src/routes/new.ts](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/payments/src/routes/new.ts)

```typescript
// 5-second pre-expiry guard: reject if expired or expiring within 5000ms
if (order.expiresAt && order.expiresAt.getTime() - Date.now() < 5000) {
    throw new BadRequestError("Order has expired or is about to expire, please re-order");
}
```

* Why **5000ms**? Stripe network round-trips take ~1.5s to 3.5s. If an order has only 2s left, Stripe is guaranteed to finish *after* expiration fires. Stopping the request before contacting Stripe eliminates 99% of race conditions.

---

### 5.2 Stripe Circuit Breaker (`opossum`)
File: [payments/src/services/stripe-client.ts](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/payments/src/services/stripe-client.ts)

If Stripe suffers an outage or severe slowdown, every Node.js request waits 80 seconds. Inbound connections saturate the event loop, Kubernetes health probes timeout, and pods restart in a cascading failure.

We wrap Stripe calls in an **Opossum Circuit Breaker**:

```typescript
import CircuitBreaker from "opossum";
import Stripe from "stripe";
import { ServiceUnavailableError } from "@mehul-mrtickets/common";
import { stripe } from "../stripe";

// Business errors (card declined, invalid card number) are normal customer mistakes
// and MUST NOT trip the circuit breaker!
export const isBusinessError = (err: any): boolean => {
    if (!err) return false;
    const type = err.type || err.name;
    return type === "StripeCardError" || type === "StripeInvalidRequestError";
};

const createCharge = async (params: ChargeParams, idempotencyKey: string): Promise<Stripe.Charge> => {
    return stripe.charges.create(params, { idempotencyKey });
};

const createRefund = async (chargeId: string, idempotencyKey: string): Promise<Stripe.Refund> => {
    return stripe.refunds.create({ charge: chargeId }, { idempotencyKey });
};

export const chargeBreaker = new CircuitBreaker(createCharge, {
    timeout: 5000,                  // Fail call if Stripe takes > 5s
    errorThresholdPercentage: 50,    // Open breaker if >= 50% of recent calls fail
    volumeThreshold: 5,             // Need at least 5 calls before evaluating error rate
    resetTimeout: 30 * 1000,        // Wait 30s before trying a trial call (HALF-OPEN)
    errorFilter: isBusinessError,   // Do NOT count card declines as failures!
});

export const chargeCard = async (params: ChargeParams, idempotencyKey: string): Promise<Stripe.Charge> => {
    try {
        return await chargeBreaker.fire(params, idempotencyKey);
    } catch (err: any) {
        if (isBusinessError(err)) {
            throw err; // Let card declines propagate normally to the client
        }
        // If breaker is OPEN or timed out -> fast fail with 503
        if (chargeBreaker.opened || err?.code === "EOPENBREAKER" || err?.code === "ETIMEDOUT") {
            throw new ServiceUnavailableError("Payment provider unavailable, please retry later");
        }
        throw new ServiceUnavailableError(err?.message || "Payment provider unavailable, please retry later");
    }
};
```

---

### 5.3 Saga Compensation Execution: `RefundRequestedListener`
File: [payments/src/events/listeners/refund-requested-listener.ts](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/payments/src/events/listeners/refund-requested-listener.ts)

When `RefundRequested` arrives from `orders`:

```typescript
import { EventMetadata, Listener, PaymentStatus, RefundRequestedEvent, Subjects } from "@mehul-mrtickets/common";
import { Payment } from "../../models/payment";
import { refundCharge } from "../../services/stripe-client";
import { PaymentRefundedPublisher } from "../publishers/payment-refunded-publisher";

export class RefundRequestedListener extends Listener<RefundRequestedEvent> {
    readonly subject: Subjects.RefundRequested = Subjects.RefundRequested;

    async onMessage(data: RefundRequestedEvent["data"], metadata: EventMetadata): Promise<void> {
        let payment = await Payment.findOne({
            $or: [{ _id: data.paymentId }, { orderId: data.orderId }],
        }).session(metadata.session || null);

        if (!payment) {
            return;
        }

        // Idempotency: If already refunded, don't refund twice!
        if (payment.status === PaymentStatus.Refunded) {
            return;
        }

        // 1. Execute Stripe refund with unique idempotency key
        const refund = await refundCharge(payment.stripeId, `refund-${payment.id}`);

        // 2. Mark payment refunded
        payment.set({ status: PaymentStatus.Refunded });
        await payment.save({ session: metadata.session });

        // 3. Atomically write PaymentRefunded to Transactional Outbox
        await new PaymentRefundedPublisher().publish({
            paymentId: payment.id,
            orderId: payment.orderId,
            stripeRefundId: refund.id,
        }, metadata.session);
    }
}
```

#### What if Stripe is down when a refund arrives?
1. The circuit breaker throws `ServiceUnavailableError`.
2. The listener throws an unhandled error.
3. Because we use `@mehul-mrtickets/common`'s transactional `EventConsumer`, the message is **not acked**.
4. The consumer retries (Phase 03).
5. If Stripe is down for an extended period, the event moves to the **Dead Letter Queue (DLQ)**.
6. The refund is **never silently dropped**. Once Stripe recovers, the DLQ is replayed and customer money is refunded.

---

## 6. Layer 4: Next.js Client User Experience

File: [client/app/orders/[orderId]/order-show.js](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/client/app/orders/%5BorderId%5D/order-show.js)

The user interface was enhanced to reflect the state machine and provide feedback during races:

```javascript
  if (order.status === 'complete') {
    return (
      <div className="alert alert-success">
        <h4>Order Complete</h4>
        <p>Your payment was successful and your ticket has been reserved!</p>
      </div>
    );
  }

  if (order.status === 'cancelled') {
    return (
      <div className="alert alert-danger">
        <h4>Order Cancelled</h4>
        <p>Your order expired before payment completed. You have been refunded.</p>
      </div>
    );
  }

  // Visual guard in the browser: disables the payment button under 5 seconds
  if (timeLeft < 5) {
    return (
      <div className="alert alert-warning">
        Order is about to expire ({timeLeft}s left). Payment is blocked to prevent duplicate billing.
      </div>
    );
  }
```

---

## 7. Verification & Test Matrix

All 26 test suites across 4 microservices pass 100%:

```text
 PASS  orders/src/models/__test__/order-transitions.test.ts
 PASS  orders/src/jobs/__test__/expire-orders-sweeper.test.ts
 PASS  orders/src/events/listeners/__test__/payment-created-listener.test.ts
 PASS  payments/src/services/__test__/stripe-client.test.ts
 PASS  payments/src/events/listeners/__test__/refund-requested-listener.test.ts
 PASS  payments/src/routes/__test__/new.test.ts
```

| Microservice | Test Suites | Total Tests | Status |
|---|:---:|:---:|:---:|
| **`orders`** | 10 | 29 | ✅ 100% PASS |
| **`payments`** | 5 | 17 | ✅ 100% PASS |
| **`tickets`** | 7 | 23 | ✅ 100% PASS |
| **`auth`** | 4 | 12 | ✅ 100% PASS |
| **Total** | **26 Suites** | **81 Tests** | ✅ **100% PASS** |

---

## 8. Senior Engineering & Interview Q&A

### Q1: Why not use 2-Phase Commit (2PC) or distributed transactions across MongoDB and Stripe?
> **Answer:** Distributed transactions across external HTTP third-party APIs (like Stripe or PayPal) are impossible because Stripe does not participate in XA/2PC protocols. Even across internal databases, 2PC holds locks across network boundaries, destroying throughput and availability (CAP theorem). The industry standard is the **Saga Pattern**: execute local transactions and use compensating events (refunds) when downstream invariants fail.

### Q2: Why choose Choreography over Orchestration for this Saga?
> **Answer:** 
> * **Choreography (our choice):** Services react to domain events (`PaymentCreated` ➔ `RefundRequested` ➔ `PaymentRefunded`). There is no central coordinator. It is lightweight, loosely coupled, and ideal for 2–3 step workflows.
> * **Orchestration (e.g., Temporal / AWS Step Functions):** A central workflow engine instructs services via RPC. It is preferred when workflows have 10+ steps, complex conditional branching, or long human-in-the-loop wait times. For a 2-service refund flow, choreography avoids introducing heavy orchestration infrastructure.

### Q3: Why must card declines NOT trip the circuit breaker?
> **Answer:** A circuit breaker monitors **infrastructure health** (network timeouts, DNS errors, HTTP 500/503 from Stripe). A card decline (`StripeCardError`) is a **business logic outcome** (insufficient funds, expired card). If 10 consecutive users enter bad card numbers on Black Friday, tripping the circuit breaker would shut down payments for thousands of legitimate customers!

### Q4: What is the purpose of the Sweeper if we already have the Expiration service?
> **Answer:** This is the **"Fast Path + Reconciliation Loop"** pattern used by Kubernetes controllers and financial engines.
> * The Expiration Service (Bull / Redis) is the **fast, precise path** (fires exactly at 60s).
> * The Sweeper is the **slow, guaranteed reconciliation loop** (finds orders older than `now - 30s` that were missed due to Redis crashes or network drops). It guarantees that no order stays stuck forever.
