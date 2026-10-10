# Phase 00 — Baseline & Load Testing

**Goal:** Build a repeatable load-testing suite and record how the system behaves **today**.
Every later phase is judged against these numbers.

---

## 1. Why This Phase Comes First

A claim like "I fixed the race condition" means nothing in an interview without numbers.
"500 concurrent buyers hit one ticket: before, 37 orders were created; after, exactly 1" is
a result people remember.

This phase **reproduces the bugs on purpose**, so we can show they are fixed later.

---

## 2. Tooling

| Tool | Why |
|---|---|
| **k6** (Grafana) | Scripts in plain JavaScript, built-in thresholds, works well on Windows |
| `kubectl exec` + `mongosh` | Read the actual DB state after a test to check consistency |

Install on Windows:
```powershell
winget install k6 --source winget
```

Tests run against `https://ticketing.dev` (already mapped in the hosts file).
k6 is configured with `insecureSkipTLSVerify: true` because of the self-signed ingress certificate.

---

## 3. Folder Structure (new, at repo root)

```text
load-tests/
├── lib/
│   ├── config.js             ← BASE_URL, shared k6 options
│   ├── auth.js               ← signup() helper, returns a logged-in cookie jar
│   └── tickets.js            ← createTicket(), createOrder(), pay() helpers
├── scenarios/
│   ├── flash-sale-race.js    ← N users buy the SAME ticket at the same moment
│   ├── double-payment.js     ← 1 user fires N payment requests for one order
│   ├── browse-load.js        ← GET /api/tickets under increasing load
│   └── purchase-flow.js      ← full flow: signup → ticket → order → pay
├── checks/
│   └── consistency.ps1       ← counts documents across service DBs, reports mismatches
└── README.md                 ← how to run each scenario
```

Each scenario is one small file that does one thing. Shared steps live in `lib/`.

---

## 4. Scenarios

### 4.1 Flash-sale race (`flash-sale-race.js`)
Proves the check-then-act bug in
[orders/src/routes/new.ts](../orders/src/routes/new.ts) (lines 23–42).

```text
setup():  seller creates 1 ticket, 200 buyers sign up (cookies stored)
default:  every VU fires POST /api/orders { ticketId } at the same moment
metric:   orders_created (Counter, incremented on 201)
expected TODAY:   orders_created > 1      ← the bug
expected AFTER 02: orders_created == 1
```

Executor: `per-vu-iterations`, 200 VUs, 1 iteration each, so all requests are fired together.

### 4.2 Double payment (`double-payment.js`)
Proves that [payments/src/routes/new.ts](../payments/src/routes/new.ts) can charge one order multiple times.

```text
setup():  user creates ticket → order
default:  http.batch() fires 10 parallel POST /api/payments { orderId, token: "tok_visa" }
metric:   payments_created (Counter on 201)
expected TODAY:   payments_created > 1   (check the Stripe test dashboard too)
expected AFTER 02: payments_created == 1
```

### 4.3 Browse load (`browse-load.js`)
Baseline read performance, compared against the Redis cache in Phase 07.

```text
seed:     500 tickets
stages:   ramp 0 → 50 → 200 VUs over 3 minutes, GET /api/tickets
record:   http_req_duration p50 / p95 / p99, requests/sec, error rate
```

### 4.4 Purchase flow (`purchase-flow.js`)
End-to-end throughput baseline and a source of traffic for the chaos tests.

```text
stages:   ramp to 50 VUs for 5 minutes
flow:     create ticket → create order → pay
record:   p95 per step, successful flows/sec, error rate
```

### 4.5 Consistency check (`checks/consistency.ps1`)
Runs `mongosh` inside the Mongo pods and compares:

| Check | Meaning when it fails |
|---|---|
| orders in `orders` DB vs tickets with `orderId` set in `tickets` DB | an event was lost (dual-write problem) |
| payments in `payments` DB vs orders with status `complete` | PaymentCreated not processed |
| more than one active order per ticket | race condition |

Run it after every load / chaos test.

---

## 5. Baseline Chaos Test (Dual-Write Proof)

```text
1. Start purchase-flow.js
2. Every 20s:  kubectl delete pod -l app=orders
3. After the run: consistency.ps1
expected TODAY: some orders exist without the matching ticket reservation (lost events)
expected AFTER 04: zero mismatches
```

Because the pod restarts on every delete, this also shows **failed requests during restarts**.
Phase 01 (graceful shutdown + readiness probes) should bring that number to zero.

---

## 6. Recording Results

Create `fixes/results/phase-00-baseline.md` with one table per scenario:

```text
| Metric                     | Value |
|----------------------------|-------|
| VUs                        |  200  |
| orders_created (1 ticket)  |   ?   |
| p95 latency                |   ?   |
| error rate                 |   ?   |
```

Also note the machine and cluster setup (CPU/RAM given to Docker Desktop), so numbers can be compared fairly.

---

## 7. Interview Angle

- "I start by reproducing the failure, then I fix it, then I prove it is fixed."
- Explain why **concurrency bugs don't show up in unit tests** but do show up under concurrent load.
- Know the difference between **load**, **stress**, **spike** and **soak** tests (stress/spike/soak are run in Phase 10).

---

## 8. Checklist

- [x] Concept lesson written in `fixes/lessons/00-load-testing-fundamentals.md`, taught & discussed in detail, and explicit go-ahead signal received from developer
- [x] `load-tests/` created with `lib/`, `scenarios/`, `checks/`
- [x] All 4 scenarios run successfully against the current system
- [x] Race condition reproduced (orders_created > 1)
- [x] Double payment reproduced (payments_created > 1)
- [x] Baseline chaos test run, mismatches recorded
- [x] `results/phase-00-baseline.md` written
- [x] `notes/00-load-testing.md` written
