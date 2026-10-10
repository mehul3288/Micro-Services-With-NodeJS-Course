# Phase 10 — Final Stress & Chaos Testing + Results Report

**Goal:** Push the finished system to its limits, break it on purpose, and produce one clear **before vs after**
report. This is the report you show in interviews and link from your resume.

---

## 1. Test Types

| Type | Question it answers | Shape |
|---|---|---|
| **Load** | Does it meet targets at expected traffic? | Steady, realistic VUs |
| **Stress** | Where does it break, and *how* does it break? | Ramp up until errors or latency explode |
| **Spike** | Can it survive a flash sale opening? | 0 → 1000 VUs in 10s, then back down |
| **Soak** | Does it degrade over time (memory leaks, growing tables, lag)? | Moderate load for 1–2 hours |
| **Chaos** | Does it stay correct when parts fail? | Kill pods / brokers / DBs during load |

All k6 scripts reuse `load-tests/lib/` from Phase 00. New scenarios go in `load-tests/scenarios/`.

---

## 2. Targets (SLOs we test against)

| SLI | Target |
|---|---|
| `GET /api/tickets` p95 | < 100 ms |
| `POST /api/orders` p95 | < 500 ms |
| `POST /api/payments` p95 (Stripe test mode) | < 2 s |
| Error rate (excluding intended 4xx/429) | < 0.5% |
| Oversold tickets | **0** (always) |
| Double charges | **0** (always) |
| Lost events (consistency check) | **0** (always) |

Encoded as k6 `thresholds`, so a run **fails** automatically if a target is missed.

---

## 3. Scenarios

### 3.1 Stress — `stress.js`
Mixed traffic (70% browse, 20% order, 10% pay), ramping 50 → 100 → 200 → 400 → 800 VUs, 2 minutes per step.
Record: the **breaking point** (first step where SLOs fail), *what* broke first (Grafana: CPU? Mongo? consumer lag?),
and whether the system **recovers** when load drops.

### 3.2 Spike / flash sale — `flash-sale-spike.js`
100 tickets released; 1000 VUs arrive within 10s and try to buy.
Must hold: **exactly 100 orders**, 0 oversold, 0 5xx, rate limits apply to bots, cache absorbs the browse surge.

### 3.3 Soak — `soak.js`
100 VUs mixed traffic for 2 hours. Watch: heap usage (flat?), outbox collection size (TTL working?),
`processedevents` size, consumer lag (stable?), p95 drift.

### 3.4 Horizontal scaling check
Re-run `stress.js` with services at 1 replica, then at 3 replicas (Kafka partitions = 3).
Record the throughput gain. Explain where it stops scaling (single Mongo primary, single Kafka broker).

---

## 4. Chaos Experiments

Each experiment runs during `purchase-flow.js` and ends with `checks/consistency.ps1`.

| # | Experiment | How | Expected (system is correct when...) | Proves phase |
|---|---|---|---|---|
| C1 | Kill a service pod repeatedly | `kubectl delete pod -l app=orders` every 20s | 0 lost events, ~0 failed requests | 01, 04 |
| C2 | Kafka down 60s | scale `kafka` StatefulSet 0 → 1 | Writes keep succeeding, outbox drains after recovery, 0 lost events | 04 |
| C3 | Mongo primary failover | Scale **orders-mongo to a 3-member replica set** for this test, kill the primary | New primary elected within ~10–15s, transactions retried, 0 lost writes | 01 |
| C4 | Redis (expiration) wiped | `redis-cli FLUSHALL` | Sweeper cancels all overdue orders | 05 |
| C5 | Stripe unreachable | Bad Stripe host via env | Breaker opens, instant 503s, other endpoints unaffected | 05 |
| C6 | Poison message | Publish malformed / schema-invalid event | DLQ'd, partition keeps moving | 03, 09 |
| C7 | Duplicate storm | Replay 1 hour of `order-events` | All skipped as duplicates, no state change | 04 |
| C8 | Network latency | Linkerd fault injection or `tc` in a debug pod: +200ms to orders-mongo | Latency rises, no errors, alerts fire | 06 |
| C9 | Cache down | Kill tickets-redis | Browse still works, latency returns to baseline | 07 |

---

## 5. The Final Report — `results/FINAL-REPORT.md`

Structure:
```text
1. Architecture diagram (final)
2. Test environment (CPU / RAM, replicas, versions)
3. Before vs After table             ← the headline
4. SLO results (pass/fail per SLI)
5. Stress: breaking point + bottleneck analysis
6. Spike: flash sale results
7. Soak: graphs over 2 hours
8. Chaos: C1–C9 table with outcome + evidence (screenshot / log link)
9. Known limits & what I would do next (multi-broker Kafka, sharding, CI/CD, multi-region)
```

### The headline table (to fill in)
| Metric | Phase 00 (before) | Phase 10 (after) |
|---|---|---|
| Orders created for 1 ticket, 500 concurrent buyers | ? | 1 |
| Charges for 1 order, 10 parallel pay clicks | ? | 1 |
| Lost events during pod-kill chaos | ? | 0 |
| Failed requests during rolling restart | ? | 0 |
| `GET /api/tickets` p95 @ 200 VUs | ? ms | ? ms |
| Max sustained RPS before SLO breach | ? | ? |
| Behavior when Kafka is down | writes lose events | writes succeed, events delayed |
| Behavior when Stripe is down | requests hang | instant 503, rest of app healthy |
| Stolen token lifetime | forever | ≤ 15 min, refresh reuse detected |

### Root README
Add a short **"Production Readiness"** section to the repo's main README with the headline table, the trace screenshot
and the Grafana screenshot, and a link to the full report. Recruiters will read that section and nothing else.

---

## 6. Interview Notes (written in this phase)

`notes/10-system-design-story.md`: a 5-minute walkthrough you can say out loud:
```text
1. What the system does (30s)
2. Architecture + why event-driven (1 min)
3. The 3 hardest problems and how I solved them (2.5 min)
     - overselling under concurrency → atomic reservation (+ numbers)
     - lost events → outbox + idempotent consumers (+ chaos result)
     - pay-at-expiry → saga with compensation
4. How I know it works: load, chaos, observability (1 min)
5. What I'd do next at 100x scale (30s)
```
Plus a **"likely follow-up questions"** list collected from notes 00–09.

---

## 7. Checklist

- [ ] Concept lesson written in `fixes/lessons/10-stress-chaos-and-fault-tolerance.md`, taught & discussed in detail, and explicit go-ahead signal received from developer
- [ ] `stress.js`, `flash-sale-spike.js`, `soak.js` with SLO thresholds
- [ ] Scaling comparison (1 vs 3 replicas)
- [ ] Chaos experiments C1–C9 executed with evidence
- [ ] `results/FINAL-REPORT.md` with the before/after table filled in
- [ ] Root README "Production Readiness" section
- [ ] `notes/10-system-design-story.md` written
