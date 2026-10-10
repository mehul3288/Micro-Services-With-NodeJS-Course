# Phase 09 — Event Contracts (Schema Registry + Pact Contract Tests)

**Goal:** Make it impossible to deploy a change that breaks another service's understanding of an event,
and catch such breaks in tests instead of in production.

**Grouped because:** the Schema Registry enforces contracts at **runtime** (the broker side). Pact verifies them at
**test time** (the code side). Together they cover how event schemas evolve.

---

## 1. The Problem

Event shapes are TypeScript interfaces in `@mehul-mrtickets/common`
(e.g. [order-created-event.ts](../common/src/events/order-created-event.ts)). TypeScript types **disappear at runtime**.

Realistic failure:
```text
1. Tickets team renames  price → priceInCents  in TicketCreatedEvent, publishes common 2.3.0
2. Tickets service deploys with 2.3.0
3. Orders service still on 2.2.0 reads data.price → undefined → Ticket replica saved with price undefined
4. Payments charges ₹0 / Stripe rejects. No compile error anywhere, because each service compiled fine on its own.
```

In a microservice system, **services deploy independently**, so producers and consumers are on different versions
of the contract at the same time. That's normal, and it has to be safe.

---

## 2. Part A — Schema Registry (Runtime Enforcement)

### How it works
```text
 Producer                          Schema Registry                         Consumer
   │ serialize(data, subject) ──► "is this compatible with the            │
   │                               previous version?"                     │
   │     ◄── schema id 7 ──────────  yes → register v3, id 7              │
   │                                 no  → REJECT (publish fails)         │
   │ value = [magic byte][id 7][JSON]                                     │
   └──────────────────────► Kafka ──────────────────────────────────────► │ read id 7 → fetch schema → validate + parse
```

### Choices
| Decision | Choice | Why |
|---|---|---|
| Registry | Confluent Schema Registry (`confluentinc/cp-schema-registry`) | Standard, stores schemas in a Kafka topic, no extra DB |
| Format | **JSON Schema** | Our payloads are already JSON; stays human-readable in `kafka-console-consumer`. Avro / Protobuf mentioned as alternatives |
| Client | `@kafkajs/confluent-schema-registry` | Built for kafkajs |
| Compatibility | **BACKWARD** (per subject) | Consumers on the new schema can read events written with the old one |
| Subject naming | `<topic>-<event-type>` (RecordNameStrategy-style) | Our topics contain several event types (Phase 03 design) |

### Rules of thumb that BACKWARD enforces
| Change | Allowed? |
|---|---|
| Add an **optional** field | ✅ |
| Remove a field | ✅ (consumers ignore it) — only after no consumer reads it |
| Add a **required** field | ❌ old events don't have it |
| Rename / change type | ❌ use add-new + deprecate-old instead |

### Code changes (all inside common, which is the benefit of base classes)
```text
common/src/events/schemas/
├── ticket-created.schema.json
├── ticket-updated.schema.json
├── order-created.schema.json
├── ...                         one JSON Schema per event, next to its TS interface
common/src/events/schema-registry.ts   register on startup + encode/decode helpers
```

- `OutboxRelay` **encodes** with the registry when publishing (the outbox row still stores plain JSON, so DB rows stay readable).
- Direct `Publisher` (expiration) encodes the same way.
- `EventConsumer` **decodes** + validates. A message that fails validation goes **straight to the DLQ** (Phase 03 path for non-retryable errors).
- Schemas are registered at service startup. An incompatible schema makes startup **fail loudly**, so the pod never becomes ready and the old version keeps serving.

### Keeping TS types and schemas in sync
The TS interfaces stay the source of truth for developers. A small test in common checks that a sample payload for each
interface validates against its JSON Schema, so if someone changes one and forgets the other, the test fails.
(Generating schemas from types with `ts-json-schema-generator` is an option, mentioned in notes.)

### Infrastructure
`infra/k8s/schema-registry-depl.yaml`: Deployment + Service `schema-registry-srv:8081`, pointing at `kafka-0.kafka-srv:9092`.
Env `SCHEMA_REGISTRY_URL` for all services.

---

## 3. Part B — Pact Message Contract Tests (Test-Time Verification)

### Why both?
The registry checks **structural compatibility** between schema versions. Pact checks that **what the consumer actually
uses** is what the producer **actually sends**, based on the consumer's real code. For example: the schema allows
`price` to be optional, but orders *needs* it. Pact catches that; the registry doesn't.

### Consumer-driven flow
```text
 1. Orders (consumer) test: "I expect a TicketCreated with id (string), title (string), price (number)"
    → runs its real TicketCreatedListener against that example
    → writes pacts/orders-service-tickets-service.json

 2. Tickets (provider) test: loads the pact file
    → builds the message using the REAL publisher payload-building code
    → verifies it matches every expectation
    → fails if tickets stopped sending something orders relies on
```

### Contracts to cover
| Consumer | Provider | Messages |
|---|---|---|
| orders | tickets | TicketCreated, TicketUpdated |
| tickets | orders | OrderCreated, OrderCancelled |
| payments | orders | OrderCreated, OrderCancelled, RefundRequested |
| expiration | orders | OrderCreated |
| orders | payments | PaymentCreated |
| orders | expiration | ExpirationComplete |

### Code layout
```text
pacts/                                          ← generated pact JSON files (repo root, committed)
orders/src/events/listeners/__pact__/ticket-events.pact.test.ts     (consumer side)
tickets/src/events/__pact__/ticket-events.provider.pact.test.ts     (provider side)
```
Library: `@pact-foundation/pact` (`MessageConsumerPact` / `MessageProviderPact`). Run with `npm run test:pact` in each service.

To make provider verification meaningful, the payload-building code must be shared between the real publish call and the
pact test. Each route builds its event data through a small function (e.g. `toTicketCreatedEvent(ticket)`) instead of an
inline object literal. This is a small refactor, and it also makes the routes cleaner.

### Without CI (for now)
Pact files live in the repo, and the provider tests read them from `../pacts`. When CI/CD is added later, the next step is
a **Pact Broker** + `can-i-deploy` gate. Documented, not built.

---

## 4. Verification

| Scenario | Expected |
|---|---|
| Add an optional field `description` to TicketCreated | Registry accepts v2; old consumers keep working |
| Rename `price` → `priceInCents` and start tickets | Registration rejected → tickets pod **not ready**, old pod keeps serving |
| Publish a hand-crafted invalid message | Consumer sends it to the DLQ with a validation error |
| Remove `price` from the tickets publisher payload | **Tickets provider pact test fails** before any deploy |
| `curl schema-registry-srv:8081/subjects` (port-forward) | All event subjects listed with versions |

Record in `results/phase-09-contracts.md`.

---

## 5. Interview Angle

- **Why types in a shared library are not a contract** in an independently deployed system.
- **BACKWARD vs FORWARD vs FULL** compatibility, and which side (producer or consumer) must upgrade first for each.
- **Safe schema evolution**: expand → migrate → contract (add new field, move consumers, remove old field).
- **JSON Schema vs Avro vs Protobuf**: readability vs size vs tooling.
- **Consumer-driven contracts**: why the consumer defines the contract, and how this replaces slow end-to-end tests.
- **Shared library coupling**: the trade-off of `@mehul-mrtickets/common` itself (convenience vs lockstep upgrades).

---

## 6. Checklist

- [ ] Concept lesson written in `fixes/lessons/09-schema-registry-and-contract-testing.md`, taught & discussed in detail, and explicit go-ahead signal received from developer
- [ ] Schema Registry deployed, `SCHEMA_REGISTRY_URL` everywhere
- [ ] JSON Schemas for all events + type/schema sync test
- [ ] Relay/publisher encode, consumer decode + validate → DLQ on failure
- [ ] Startup registration with BACKWARD compatibility, fail-fast
- [ ] Event payload builder functions extracted (shared by routes and pact tests)
- [ ] Pact consumer + provider tests for all contracts in the table
- [ ] Verification scenarios run, results recorded
- [ ] `notes/09-event-contracts.md` written
