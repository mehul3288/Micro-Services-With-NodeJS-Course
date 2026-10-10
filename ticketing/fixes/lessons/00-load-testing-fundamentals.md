# Lesson 00 — Baseline & Load Testing Fundamentals

> **Phase Goal:** Build an automated load testing suite using **k6** to deliberately reproduce and measure the concurrency bugs, race conditions, and performance baselines of our current system *before* we write any production fixes.

---

## 1. The Big Picture

Imagine you own a movie theater with 1 VIP front-row seat left.
If customer Alice arrives at the counter at 10:00 AM, the cashier sees the seat is empty and sells it to Alice.
If Bob arrives at 10:05 AM, the cashier sees the seat is taken and says "Sorry, sold out." Everything works fine.

Now imagine a flash sale online:
At 10:00:00.000 AM, **500 customers** click "Buy" on that exact same seat at the exact same millisecond.
If the cashier system checks:
1. "Is the seat free?" (Yes, it's free for all 500 requests at 10:00:00.010 AM)
2. "Okay, print the ticket!" (All 500 requests print a ticket at 10:00:00.050 AM)

You just sold **1 seat to 500 people**. You now have 499 furious customers, chargebacks, and legal liability.

In software engineering, you cannot fix a performance or concurrency bug until you can **reliably trigger it and measure it**.
If an engineer says in an interview: *"I improved performance and fixed race conditions,"* the interviewer's immediate response is:
> *"How do you know? What was the throughput before? How many duplicate orders were generated under 500 concurrent requests? What was the p95 latency before and after?"*

Without numbers, it is just an unproven assumption.
**Phase 00 is all about giving us undeniable, empirical proof.** We write automated load test scripts to crash, overload, and expose our existing flaws on purpose.

---

## 2. The Problem Today (In Our Exact Code)

Our current ticketing microservices pass all Jest unit tests. Why? Because Jest tests run sequentially (one request after another).
In the real world, multiple requests hit our Express servers simultaneously.

### Bug 1: The "Check-Then-Act" (TOCTOU) Race Condition
Look at [orders/src/routes/new.ts](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/orders/src/routes/new.ts#L23-L43):

```typescript
// 1. Check if the ticket is reserved
const isReserved = await ticket.isReserved();
if (isReserved) {
    throw new BadRequestError("Ticket is already reserved");
}

// ... calculate expiration ...

// 2. Build the order and save it to the DB
const order = Order.build({ ... });
await order.save();
```

Here is the exact execution timeline when Request A and Request B arrive concurrently:

```text
Time       Request A (User 1)                    Request B (User 2)
──────────────────────────────────────────────────────────────────────────────────
T0         Read DB: is ticket reserved?          Read DB: is ticket reserved?
           ↳ DB returns FALSE                    ↳ DB returns FALSE
──────────────────────────────────────────────────────────────────────────────────
T1         Proceeds to create Order A            Proceeds to create Order B
──────────────────────────────────────────────────────────────────────────────────
T2         orderA.save() succeeds!               orderB.save() succeeds!
──────────────────────────────────────────────────────────────────────────────────
Outcome:   BOTH users received Order Confirmation for the SAME physical ticket!
```

Because there is an asynchronous gap between checking `isReserved()` and committing `order.save()`, any number of concurrent requests can slip through that gap.

---

### Bug 2: Double Payment Vulnerability
Look at [payments/src/routes/new.ts](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/payments/src/routes/new.ts#L30-L44):

```typescript
// Only checks if the order is cancelled!
if (order.status === OrderStatus.Cancelled) {
    throw new BadRequestError("Cannot pay for a cancelled order");
}

// Calls Stripe to charge the credit card
const charge = await stripe.charges.create({
    currency: "usd",
    amount: order.price * 100,
    source: token,
});

// Saves payment to database
const payment = Payment.build({ orderId, stripeId: charge.id });
await payment.save();
```

What goes wrong here?
1. **No Check for Already Completed Orders:** If an order is already `OrderStatus.Complete`, this route allows another payment to go through!
2. **No Idempotency Key in Stripe Call:** If the user double-clicks "Submit Payment" or network lag causes a retry, Stripe charges the customer's card twice.
3. **No Unique Constraint in DB:** The `payments` MongoDB collection has no unique index on `orderId`. Multiple payment documents can be inserted for one order.

---

### Bug 3: Unknown Throughput & Latency Thresholds
When 200 users browse tickets on `GET /api/tickets`, what happens to our ingress controller and MongoDB?
- Does latency jump from 30ms to 2,000ms?
- Do pods run out of memory?
- Does NGINX drop connections?
We have zero baseline metrics.

---

## 3. Core Concepts

### A. What is Load Testing?
Load testing simulates real human traffic hitting your application. Instead of real browsers, a load testing tool spawns **Virtual Users (VUs)** that make HTTP requests as fast as real users would.

```text
 ┌────────────────────────────────────────────────────────┐
 │                      k6 Engine                         │
 │                                                        │
 │  [ VU 1 ] ──► POST /api/orders (Ticket 123) ────────┐  │
 │  [ VU 2 ] ──► POST /api/orders (Ticket 123) ───────┼──┼──► Ingress ──► Services
 │  [ VU 3 ] ──► POST /api/orders (Ticket 123) ───────┘  │
 └────────────────────────────────────────────────────────┘
```

* **VU (Virtual User):** An independent execution thread running your test script in a loop.
* **RPS (Requests Per Second):** How many HTTP calls your system processes per second.
* **Latency Percentiles (p50, p90, p95, p99):**
  * Average latency is misleading (if 9 users take 10ms and 1 user takes 10,000ms, average is ~1,000ms).
  * **p95 (95th Percentile):** 95% of users experienced a response time faster than this number. Only 5% were slower. This is the industry standard SLA metric.

### B. Types of Performance Testing

| Type | What It Does | Our Scenario in Ticketing |
|---|---|---|
| **Load Testing** | Tests expected normal-to-peak traffic | 100 users browsing and purchasing tickets over 2 minutes |
| **Stress Testing** | Pushes traffic until the system breaks to find breaking point | Ramping up traffic until MongoDB CPU hits 100% or pods drop |
| **Spike Testing** | Sudden, violent burst from 0 to 500 VUs in 2 seconds | Flash sale opening: 500 users competing for 1 ticket |
| **Chaos Testing** | Introducing infrastructure failure under traffic | Killing a pod while requests are in-flight to check data loss |

### C. Why k6?
We use **k6** (by Grafana Labs):
1. **Written in JavaScript/ES6:** Seamless for Node.js developers.
2. **Ultra-High Performance:** The engine itself is written in Go, so a single laptop can generate thousands of concurrent requests without maxing out local CPU.
3. **Thresholds & Assertions:** Lets you define pass/fail criteria directly in code (e.g., `http_req_duration: ['p(95)<500']`).

### D. Why Jest Unit Tests Miss Concurrency Bugs

Our current Jest test suite in `orders/src/routes/__test__/new.test.ts` passes 100% of the time, yet a critical race condition exists. Why?

Jest executes tests **strictly sequentially** (one request after another):

```typescript
// Test 1: buys ticket
await request(app).post("/api/orders").send({ ticketId }).expect(201);

// Test 2: tries to buy the same ticket
await request(app).post("/api/orders").send({ ticketId }).expect(400); // Passes!
```

Because of `await`, Request 1 completely finishes and writes the order to MongoDB before Request 2 ever starts. When Request 2 runs, `ticket.isReserved()` queries MongoDB, finds the existing order, and correctly returns HTTP 400.

**In production, real users hit the API concurrently (interleaved in time):**

```text
Time    Request 1 (Alice)                  Request 2 (Bob)
──────────────────────────────────────────────────────────────────────────
T0      Express receives Request 1         Express receives Request 2
T1      Runs: await ticket.isReserved()    Runs: await ticket.isReserved()
        ↳ MongoDB query in flight...       ↳ MongoDB query in flight...
T2      MongoDB replies: "false"           MongoDB replies: "false"
        (No order in DB yet!)              (No order in DB yet!)
T3      Alice's order.save() succeeds      Bob's order.save() succeeds
──────────────────────────────────────────────────────────────────────────
Result: Both users get order confirmation for the EXACT SAME ticket!
```

**Key Takeaway:** Unit tests verify isolated business logic. Race conditions are **timing bugs** that only happen when multiple requests overlap in time. Only load tests (like k6) can catch them.

### E. Why Average Latency is a Dangerous Metric (And Why We Use p95)

#### The "Oven & Freezer" Analogy
> *"If your head is in a hot oven at 150°C and your feet are in an ice bucket at -20°C, on average your body temperature is a comfortable 65°C. But you are dead."*

Relying on **average (mean)** latency in a distributed system conceals critical failures.

#### The Real Math
Imagine 100 users submit an order:
* **95 users** get a super-fast response: **20ms**
* **5 users** hit a database connection timeout or disk lock: **5,000ms (5 seconds)**

Calculate the average:
* `Total time = (95 × 20ms) + (5 × 5,000ms) = 1,900ms + 25,000ms = 26,900ms`
* `Average latency = 26,900ms / 100 = 269ms`

An engineering dashboard showing an average of **269ms** looks green and healthy.
**The reality:** 5 out of every 100 customers (5%) stared at a frozen screen for 5 seconds. If you handle 100,000 orders a day, that is **5,000 angry customers** experiencing timeouts or double-clicking payments — completely hidden by the average!

#### Why SRE Uses Percentiles (p50, p95, p99)
Percentiles rank all response times from fastest to slowest:
* **p50 (Median):** 50% of requests were faster than this number.
* **p95 (95th Percentile):** 95% of requests were faster than this number. Only the worst 5% were slower.
  * In the example above, **p95 = 5,000ms**. The dashboard turns red immediately, exposing the 5-second problem.
* **p99 (99th Percentile):** The worst 1% of requests.

#### The Microservices Multiplier Effect
In microservices, one user checkout action triggers multiple downstream services (`Auth` → `Orders` → `Tickets` → `Payments`).

If each service has just a **5% chance** of being slow (p95 threshold):
* `Probability that the user experiences a delay = 1 - (0.95 × 0.95 × 0.95 × 0.95) = 1 - 0.814 = 18.6%`

Nearly **1 out of every 5 checkout requests will be slow**, even though every single microservice claims its "average" is fine!

This is why all our k6 load tests enforce **p95 thresholds** (e.g. `http_req_duration: ['p(95)<500']`) rather than averages.

---

## 4. How It Applies Here

We will build a dedicated `load-tests/` directory at the project root containing 4 automated test scenarios:

```text
load-tests/
├── lib/
│   ├── config.js          # Base URL (https://ticketing.dev), timeouts, headers
│   ├── auth.js            # Registers test accounts and extracts auth session cookies
│   └── tickets.js         # API helpers to create tickets, orders, and payments
├── scenarios/
│   ├── flash-sale-race.js # 500 VUs buy the EXACT SAME ticket concurrently
│   ├── double-payment.js  # 1 VU fires 10 simultaneous payments for 1 order
│   ├── browse-load.js     # Ramping load on GET /api/tickets to measure latency
│   └── purchase-flow.js   # Full end-to-end user journey under load
├── checks/
│   └── consistency.ps1    # PowerShell script querying Mongo to count duplicate orders/payments
└── README.md              # Instructions for running and interpreting tests
```

---

## 5. Alternatives Considered

* **Apache JMeter:** Heavy Java GUI, XML configuration, high memory footprint on developer machines.
* **Artillery:** Node.js based, but higher CPU overhead when generating high concurrency on Windows.
* **k6 (Chosen):** Lightweight, zero memory leaks, CLI native, scriptable in JS, and outputs JSON metrics that easily plug into Grafana (which we configure in Phase 06).

---

## 6. What Will Change in Phase 00

* **No source code in `/orders`, `/tickets`, `/payments`, or `/auth` is modified yet!**
* We create the `load-tests/` test suite at root.
* We run the tests against our current live Kubernetes cluster (`https://ticketing.dev`).
* We record the baseline failures in `fixes/results/phase-00-baseline.md`.

---

## 7. Glossary

* **TOCTOU (Time of Check to Time of Use):** A race condition where state changes between when software checks a condition and when it acts on that condition.
* **Idempotency:** An operation that produces the exact same outcome whether executed once or 100 times.
* **Virtual User (VU):** Simulated user thread in load testing.
* **p95 Latency:** The response time threshold that 95% of requests stay beneath.
* **Double-Spend / Double-Charge:** A failure where the same resource or balance is consumed more than once.

---

## 8. Self-Check Questions

Test your understanding before we proceed:

<details>
<summary><b>1. Why can Jest unit tests pass with flying colors even though a fatal race condition exists?</b></summary>

Jest unit tests execute **strictly sequentially** (one request at a time):

```typescript
// Test 1: buys ticket
await request(app).post("/api/orders").send({ ticketId }).expect(201);

// Test 2: tries to buy the same ticket
await request(app).post("/api/orders").send({ ticketId }).expect(400); // Passes!
```

Because of `await`, Request 1 completely finishes and commits the order to MongoDB before Request 2 ever starts. When Request 2 runs, `ticket.isReserved()` sees the order in the database and returns 400.

**In production, requests arrive concurrently (interleaved in time):**

```text
Time   Request 1 (Alice)                  Request 2 (Bob)
───────────────────────────────────────────────────────────────────────
T0     Express receives Request 1         Express receives Request 2
T1     Runs: await ticket.isReserved()    Runs: await ticket.isReserved()
       ↳ DB query in flight...            ↳ DB query in flight...
T2     MongoDB replies: "false"           MongoDB replies: "false"
T3     Alice's order.save() succeeds      Bob's order.save() succeeds
Outcome: Both users get an order confirmation for the EXACT SAME ticket!
```

**Takeaway:** Unit tests verify isolated business logic. Race conditions are timing bugs that only appear when asynchronous operations overlap in time.

</details>

<details>
<summary><b>2. In our orders service, what is the exact gap causing the flash-sale race condition?</b></summary>
The gap between <code>await ticket.isReserved()</code> and <code>await order.save()</code>. During this window, any other concurrent request querying <code>isReserved()</code> still sees no active order and passes validation.
</details>

<details>
<summary><b>3. Why is average latency a dangerous metric in production systems?</b></summary>

**The Flaw of Averages:** Averages hide extreme outliers.
- If 95 users experience 20ms and 5 users experience 5,000ms (5 seconds), the average is **269ms**.
- The dashboard looks green, but **5% of your customers suffered a frozen screen**.
- In microservices, tail latency multiplies: if 4 services each have a 5% delay probability, nearly **18.6%** of user checkouts will experience slowness.
- **Solution:** Always measure **p95** (95th percentile) or **p99**, which directly exposes how many users are suffering degraded performance. (See [Section 3.E](#e-why-average-latency-is-a-dangerous-metric-and-why-we-use-p95) for the complete breakdown).

</details>

<details>
<summary><b>4. In payments, why is checking <code>order.status === OrderStatus.Cancelled</code> insufficient?</b></summary>
It fails to check if the order is already <code>OrderStatus.Complete</code> (already paid). If a second payment request arrives for the same order, it proceeds and charges the user a second time.
</details>

<details>
<summary><b>5. What is the role of Phase 00 before we start writing any fixes?</b></summary>
Phase 00 provides our baseline proof. By intentionally writing tests that reproduce the race condition and record the failure rate, we establish an objective benchmark to prove our Phase 02 and Phase 04 fixes actually worked.
</details>
