# Ticketing → Production-Ready Distributed System

This folder contains the plan for turning the ticketing app into a production-grade
distributed system. Every phase has its own lesson, plan file, measured results and interview notes.

---

## Table of Contents
0. [Phase Workflow: Learn → Approve → Build](#0-phase-workflow-learn--approve--build)
1. [Roadmap](#1-roadmap)
2. [Phase Dependency Map](#2-phase-dependency-map)
3. [Coding Rules (Non-Negotiable)](#3-coding-rules-non-negotiable)
4. [Definition of Done for Every Phase](#4-definition-of-done-for-every-phase)
5. [Folder Layout](#5-folder-layout)
6. [Working With the Common Package](#6-working-with-the-common-package)
7. [Local Cluster Resource Budget](#7-local-cluster-resource-budget)

---

## 0. Phase Workflow: Learn → Approve → Build

> [!IMPORTANT]
> **MANDATORY RULE: No phase starts with code.**
> Before any implementation begins, the assistant must teach the concepts and the complete purpose of the phase in detail.
> The developer must fully understand the "why" and "how" first. Implementation starts ONLY after the developer gives an explicit go-ahead signal.

```text
 ┌────────────────┐   ┌──────────────┐   ┌─────────────┐   ┌─────────────┐   ┌──────────────┐
 │ 1. TEACH/LEARN │──►│ 2. Q&A       │──►│ 3. SIGNAL   │──►│ 4. BUILD    │──►│ 5. PROVE &   │
 │ deep dive      │   │ clarify      │   │ "go ahead"  │   │ clean code  │   │    NOTES     │
 └────────────────┘   └──────────────┘   └─────────────┘   └─────────────┘   └──────────────┘
```

### Step 1: Teach & Learn (before ANY code or config changes)
The assistant writes a comprehensive lesson to `fixes/lessons/NN-<topic>.md` **and** explains the core concepts and purpose in detail directly in the conversation:

```text
1. The Big Picture      → what this phase is about, its whole purpose in plain language
2. The Problem Today    → what goes wrong today, pinpointed with OUR existing code and failure scenarios
3. Core Concepts        → each concept explained from scratch (what it is, why it exists, how it works),
                          using ASCII diagrams and clear real-world analogies
4. How It Applies Here  → exact mapping to our services, files, models, events, and data flows
5. Alternatives         → other ways to solve it, and why we chose this specific architecture
6. What Will Change     → preview of files to be created or modified (without writing code yet)
7. Glossary             → every new architectural term defined in one crisp line
8. Self-Check Questions → 5–10 concept questions to verify complete understanding (collapsible answers)
```

The lesson teaches *concepts and architecture*. The phase plan file (`NN-*.md`) is the *implementation checklist*.

### Step 2: Q&A & Mental Model Alignment
The developer reads the lesson and asks any questions. The assistant clarifies doubts, dives deeper into edge cases, and updates the lesson if anything is ambiguous.

### Step 3: Explicit Go-Ahead Signal
Implementation begins **ONLY AFTER** the developer gives an explicit signal, e.g.:
> *"I have understood the whole thing, go ahead and start with Phase 00"* or *"Go ahead with Phase 01"*.

**Until that explicit signal is given:**
- No application source code is created or modified.
- No Kubernetes manifests or Dockerfiles are altered.
- No packages or dependencies are updated or published.

### Step 4: Build (Clean & Structured)
Once signaled, implementation proceeds step-by-step following the [Coding Rules](#3-coding-rules-non-negotiable).
Code must remain clean, simple, human-readable, and well-tested — no cluttered AI slop or unnecessary abstractions.

### Step 5: Prove & Interview Notes
- Tests and k6 load/chaos tests are executed, and proof numbers are saved in `results/`.
- Interview-ready notes are documented in `notes/` following the structured template.

| Folder | Written when | Purpose |
|---|---|---|
| `lessons/` | **Before** the phase | Deeply understand the concepts and purpose |
| `NN-*.md` plans | Already written | What to build, step by step |
| `results/` | After the phase | Concrete proof (numbers, metrics, comparisons) |
| `notes/` | After the phase | Interview revision notes linked to real code |

---

## 1. Roadmap

| # | Phase | What it delivers | Proof |
|---|---|---|---|
| 00 | [Baseline & Load Testing](./00-baseline-load-testing.md) | k6 test suite + "before" numbers | Race condition and double charge reproduced |
| 01 | [Infrastructure Foundation](./01-infrastructure-foundation.md) | Mongo replica sets + PVCs, Redis persistence, health probes, graceful shutdown | Pod restart → zero data loss, zero failed requests during rollout |
| 02 | [Correctness & Concurrency](./02-correctness-and-concurrency.md) | Atomic ticket reservation, payment guards, Stripe idempotency key, small bug fixes | 500 buyers / 1 ticket → exactly 1 order |
| 03 | [Kafka Migration](./03-kafka-migration.md) | STAN → Kafka, per-entity partition keys, retry with backoff, Dead Letter Queue | Poison message → DLQ, rest of the stream keeps flowing |
| 04 | [Reliable Messaging](./04-reliable-messaging.md) | Transactional Outbox, idempotent consumers | Kill pod mid-request → zero lost / zero duplicated events |
| 05 | [Payment Saga & Resilience](./05-payment-saga-and-resilience.md) | Order state machine, refund compensation, expiry sweeper, circuit breaker | Pay-at-expiry race → automatic refund; Stripe down → fast 503 |
| 06 | [Observability](./06-observability.md) | Pino logs, OpenTelemetry tracing, Prometheus metrics, Grafana dashboards | One trace across all services; live RED dashboard |
| 07 | [Caching & API Gateway](./07-caching-and-api-gateway.md) | Redis cache for tickets, pagination, Kong gateway, rate limiting | p95 latency before/after; bots get 429 |
| 08 | [Security Hardening](./08-security-hardening.md) | Refresh token rotation, Sealed Secrets, Linkerd mTLS + authorization policies | Stolen refresh token reuse detected; plain-text traffic blocked |
| 09 | [Event Contracts](./09-event-contracts.md) | Schema Registry (JSON Schema), Pact message contract tests | Breaking schema change rejected before deploy |
| 10 | [Final Stress & Chaos Testing](./10-final-stress-and-chaos-testing.md) | Stress, spike, soak and chaos runs + final results report | Before vs after comparison table |

CI/CD (Helm, ArgoCD, canary) is **out of scope for now**.

---

## 2. Phase Dependency Map

```text
  00 Baseline ──► 01 Infra Foundation ──► 02 Correctness ──► 03 Kafka ──► 04 Outbox + Idempotency
                        │                                                     │
                        │  (Mongo replica set is REQUIRED                     ▼
                        │   for transactions used in 04)            05 Payment Saga & Resilience
                        │                                                     │
                        └─────────────────────────────────────────────────────▼
                                                                    06 Observability
                                                                              │
                                                     ┌────────────────────────┼──────────────────┐
                                                     ▼                        ▼                  ▼
                                            07 Cache + Gateway       08 Security        09 Event Contracts
                                                     └────────────────────────┼──────────────────┘
                                                                              ▼
                                                                  10 Final Stress & Chaos
```

Why this order:
- **01 before 04**: MongoDB multi-document transactions only work on a replica set. The outbox depends on them.
- **03 before 04**: The outbox relay publishes to Kafka, so the broker has to be in place first.
- **06 after 05**: Tracing is most useful once the event flows are final (outbox, saga), so we instrument them once.
- **07, 08, 09** are independent of each other and can be done in any order.

---

## 3. Coding Rules (Non-Negotiable)

The new code must read like the existing code. The rules below are taken from the current codebase.

**Structure**
- One responsibility per file. File names are `kebab-case.ts` (`order-created-listener.ts`, `cancel-order.ts`).
- Keep the existing folders: `routes/`, `models/`, `events/listeners/`, `events/publishers/`, `__test__/`.
- New folders are added only when a new *kind* of thing appears: `services/` (shared business logic), `jobs/` (background loops).
- Routes stay as one file per endpoint and end with `export { router as xRouter }`.
- Models keep the `Attrs / Doc / Model` interfaces + `build()` static pattern.

**Style**
- 4-space indentation, double quotes, `async/await`.
- Comments explain **why**, not what. No comment banners, no emoji, no commented-out code blocks.
- No generic `utils.ts` / `helpers.ts` dumping grounds. A helper either belongs to a clear file name or is not needed.
- No premature abstraction: no factories, DI containers or "managers" unless there are already 2+ real use cases.
- Env vars are validated at the top of `index.ts`, just like `JWT_KEY` and `MONGO_URI` today.

**Shared code**
- Code needed by 2+ services goes into `@mehul-mrtickets/common` (base listener/publisher, errors, middlewares, outbox).
- Code specific to one service stays in that service.

**Tests**
- Every behavior change comes with a Jest test next to the code in `__test__/`.
- The existing test style (supertest + `global.signin()`) is kept.

---

## 4. Definition of Done for Every Phase

A phase is complete only when **all** of the following are true:

1. The lesson in `lessons/` was written, core concepts and purpose were thoroughly taught and clarified, and the developer gave explicit go-ahead **before** any code or manifests were touched.
2. Code implemented following the rules above (clean, structured, human-readable).
3. All existing tests pass, and new tests cover the new behavior.
4. The phase's load / chaos test has been run and the numbers are recorded in `results/`.
5. Interview notes are written in `notes/`, based on the code as actually implemented.
6. The checklist at the bottom of the phase file is fully ticked.

---

## 5. Folder Layout

```text
fixes/
├── README.md                              ← you are here
├── 00-baseline-load-testing.md            ← implementation plans (one per phase)
├── 01-infrastructure-foundation.md
├── ...
├── 10-final-stress-and-chaos-testing.md
├── lessons/                               ← concept lessons, written BEFORE each phase
│   └── 00-load-testing-fundamentals.md
├── results/                               ← measured numbers, screenshots (filled per phase)
│   └── phase-00-baseline.md
└── notes/                                 ← interview-ready notes (filled per phase)
    └── 02-race-conditions.md

load-tests/                                ← k6 scripts (created in Phase 00, at repo root)
```

### Notes format
Every note in `notes/` follows the same structure so it is quick to revise before an interview:

```text
1. The Problem        → what breaks, with a concrete scenario
2. Why It Matters     → business impact (lost money, oversold tickets, ...)
3. The Solution       → the pattern, in one paragraph
4. How We Built It    → links to the real files + a diagram
5. Trade-offs         → what we gave up, alternatives we rejected and why
6. Numbers            → before / after from results/
7. Interview Q&A      → 5–8 likely questions with crisp answers
```

---

## 6. Working With the Common Package

Several phases change `@mehul-mrtickets/common`. The workflow for each change:

```text
1. Edit common/src/...
2. cd common && npm run pub            (bumps version, builds, publishes)
3. In every affected service:  npm install @mehul-mrtickets/common@latest
4. Skaffold rebuilds the images automatically
```

Breaking changes to the common package (Phase 03 Kafka migration) get a **major** version bump
(`npm version major`), so services can't silently pick up an incompatible version.

---

## 7. Local Cluster Resource Budget

The cluster grows as phases are added. Rough pod counts:

| After phase | Approx. pods | Suggested Docker Desktop allocation |
|---|---|---|
| 00–02 | ~13 | 4 CPU / 6 GB |
| 03–05 | ~15 (Kafka replaces NATS) | 4 CPU / 8 GB |
| 06 | ~19 (Prometheus, Grafana, Jaeger, kafka-exporter) | 6 CPU / 10 GB |
| 07–09 | ~24 (Kong, Redis, Linkerd, Schema Registry) | 6–8 CPU / 12 GB |

To keep this manageable:
- Mongo runs as a **single-member replica set** per service by default (enough for transactions).
  A 3-member set is used only in Phase 10 to demonstrate failover.
- Kafka runs as a **single broker in KRaft mode** (no ZooKeeper).
- The observability stack lives in its own folder (`infra/k8s/observability/`) so it can be switched off.
