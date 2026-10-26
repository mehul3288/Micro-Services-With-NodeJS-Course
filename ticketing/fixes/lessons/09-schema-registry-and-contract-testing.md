# Phase 09: Event Contracts (Confluent Schema Registry & Pact Contract Testing)

> **Phase Goal:**
> Make it structurally impossible to deploy a breaking event change to production.
> We establish a dual-layer contract safety net:
> 1. **Runtime Enforcement (Broker-Side):** Confluent Schema Registry enforcing **BACKWARD** compatibility rules and wire-format serialization.
> 2. **Test-Time Verification (Code-Side):** Consumer-Driven Contract (CDC) testing via **Pact** to ensure consumers and producers stay in lockstep without slow end-to-end integration environments.

---

## 1. The Architectural Trap: Why TypeScript Types Are Not Contracts

In monolithic architectures, all modules compile together. If you change a function argument, the TypeScript compiler catches every caller across the repository before code runs.

In microservices, developers often fall into a dangerous trap:
> *"We have all our event types defined as TypeScript interfaces in `@mehul-mrtickets/common`. Both services import this package. Therefore, we are type-safe!"*

**"Wait! When I call `publish(data)` inside a service, TypeScript strictly enforces the argument type. I cannot pass arbitrary or misspelled fields—it throws a compile error! So how could this ever happen?"**

This is one of the most critical conceptual breakthroughs in distributed systems:
> **Inside a single service at a single point in time, TypeScript's `publish()` function does indeed protect you from typos. But production failures do NOT occur from typos within one file. They occur from EVOLUTION OVER TIME across INDEPENDENTLY DEPLOYED SERVICES.**

Here are the 4 real-world reasons why compile-time types cannot protect you in production:

---

### Reason 1: The Independent Deployment Timeline (Version Skew)

In microservices, services **deploy independently on different days, on different schedules, by different teams**.

Look at how a breaking change happens even when **every service compiles with 0 TypeScript errors**:

```text
MONDAY 10:00 AM — Both services are on Common v1.0.0
────────────────────────────────────────────────────
Tickets Service (v1.0.0)  ─── publishes { id, title, price } ───► Orders Service (v1.0.0)
• Tickets compile: 0 errors                                       • Orders compile: 0 errors
• Runtime: Everything works perfectly.


TUESDAY 2:00 PM — Tickets Team needs to support cents
─────────────────────────────────────────────────────
1. Developer edits `@mehul-mrtickets/common`:
   Renames `price: number`  ➔  `priceInCents: number`
   Publishes common version v2.0.0.

2. Tickets developer runs in `tickets`:
   `npm install @mehul-mrtickets/common@2.0.0`
   Updates tickets code: `publish({ id, title, priceInCents: 5000 })`
   • Tickets compile: 0 ERRORS! (TypeScript is 100% satisfied)
   • Tickets tests: 100% PASS!
   Tickets deploys to Kubernetes production at 2:30 PM.


TUESDAY 2:31 PM — The Production Disaster
─────────────────────────────────────────
• Orders Service was NOT touched today. It is STILL running in production on v1.0.0!
• Orders listener code in production executes:
     const { id, title, price } = data; // data has priceInCents, NOT price!
• `price` evaluates to `undefined`!
• Orders saves a ticket with price `undefined`.
• Customer buys ticket ➔ Payments charges ₹0 or Stripe crashes with 400.
```

**Notice what just happened:**
- Did the Tickets developer make any TypeScript error? **No.**
- Did the Orders developer make any TypeScript error? **No.**
- Both services had 100% type safety on their own machines.
- **Yet production completely broke because the consumer was running an older version of the contract than the producer.**

---

### Reason 2: TypeScript Type Assertions (`as`) Are Erased at Runtime

Look closely at how our `EventConsumer` (or `onMessage` listener) parses messages from Kafka:

```typescript
// Inside listener/consumer:
const parsedData = JSON.parse(message.value.toString());
const data = parsedData as TicketCreatedEvent['data'];
```

When you write `as TicketCreatedEvent['data']`:
- **TypeScript does ZERO runtime validation.**
- The `as` keyword is merely a promise to the compiler: *"Trust me, whatever JSON came over the network has this shape."*
- If the incoming Kafka message has `{ id: "123", title: "Concert", foo: "bar" }` with missing `price`, `JSON.parse` happily parses it, and `data.price` is silently `undefined`.
- TypeScript is completely erased in compiled JavaScript. It cannot inspect what fields are actually inside the buffer at runtime.

---

### Reason 3: Replaying Historical Events (The Kafka Event Store)

Kafka is not an ephemeral queue; it is a **durable, persistent log**. Messages stay in Kafka for 7 days, 30 days, or forever.

Imagine this scenario:
1. In Month 1, Tickets publishes 100,000 events: `{ id, title, price }`.
2. In Month 2, the team adds a new **required** field: `venue: string`.
3. In Month 3, an engineer spins up a new analytics service or replays the topic from offset 0 to rebuild the database.
4. The new consumer code expects `data.venue.toUpperCase()`.
5. When it reads the 100,000 historical events from Month 1, `data.venue` is `undefined` ➔ `TypeError: Cannot read properties of undefined (reading 'toUpperCase')` ➔ **Consumer crashes in an infinite loop!**

TypeScript cannot check events that were published weeks ago.

---

### Reason 4: Polyglot Microservices & Third-Party Producers

In modern enterprise architectures:
- The backend might have Node.js services, a Python data-science service, a Go payment gateway, or an external webhook publisher.
- A Python or Go service publishing to Kafka **does not use TypeScript**.
- Without a Schema Registry at the Kafka broker level, there is no gatekeeper validating whether the producer's JSON matches the agreed schema.

---

## 2. Real-World Analogy: The Electrical Outlet & The Power Plug

To understand why we need both **Schema Registry** and **Pact**, think of an electrical power grid:

```text
                       ┌───────────────────────────────┐
                       │   Confluent Schema Registry   │
                       │   (The International Standard)│
                       └───────────────┬───────────────┘
                                       │ Enforces Physical Dimensions
                                       ▼
    ┌──────────────────────┐                       ┌──────────────────────┐
    │     Wall Socket      │ ═════════════════════ │    Appliance Plug    │
    │      (Producer)      │     230V @ 50Hz       │      (Consumer)      │
    └──────────────────────┘                       └──────────────────────┘
               ▲                                              ▲
               └──────────────────────┬───────────────────────┘
                                      │
                        Pact Contract Testing
                   (Does this blender actually work
                   with the current voltage supplied?)
```

1. **The Schema Registry (The Physical Standard):**
   - The Schema Registry defines the physical dimensions: Type C plug, 2 round pins, 19mm pin spacing.
   - If a manufacturer tries to sell a plug with triangular pins, the standard **rejects it immediately at runtime**—it physically cannot enter the socket.
2. **Pact Contract Testing (The Appliance Compatibility):**
   - Even if the plug physically fits the wall, does the socket provide the 230V that the appliance's motor expects, or does it only supply 110V?
   - Pact tests the **consumer's semantic expectations** before the appliance ever leaves the factory.

---

## 3. Layer 1: Confluent Schema Registry (Runtime Enforcement)

### How Schema Registry Works on the Wire

Instead of transmitting arbitrary, unvalidated JSON blobs, every message published to Kafka is encoded according to the **Confluent Wire Format**:

```text
 ┌──────────────┬────────────────────────┬───────────────────────────────────────┐
 │ Magic Byte   │ Schema ID (4 bytes)    │ Serialized Payload (JSON Schema)      │
 │ 0x00 (1 byte)│ Big-Endian 32-bit uint │ {"id":"123","title":"Concert",...}   │
 └──────────────┴────────────────────────┴───────────────────────────────────────┘
```

```text
 [ Producer: Tickets Service ]
       │
       │ 1. Encode payload & query Schema Registry:
       │    "Is this JSON matching subject 'ticket-events-TicketCreated'?"
       ▼
 ┌─────────────────────────────────────────────────────────┐
 │ Confluent Schema Registry                                │
 │ - Verifies schema against compatibility rules (BACKWARD)│
 │ - Assigns unique Schema ID (e.g. ID = 4)                │
 └─────────────────────────────┬───────────────────────────┘
                               │ Returns Schema ID: 4
                               ▼
 [ Producer: OutboxRelay ]
       │ Prepends [0x00][0x00 0x00 0x00 0x04] to JSON
       ▼
 [ Kafka Topic: ticket-events ]
       ▼
 [ Consumer: Orders Service (EventConsumer) ]
       │ Reads magic byte + Schema ID 4
       │ Fetches schema 4 from registry (cached locally in memory)
       │ Validates payload against JSON Schema
       ├─ Valid ──► Dispatches to TicketCreatedListener
       └─ Invalid ──► Rejects & routes directly to Dead Letter Queue (DLQ)
```

---

### Schema Compatibility Modes: What They Mean & Who Must Upgrade First

Confluent Schema Registry provides strict compatibility modes. The most critical decision in event streaming is choosing the right compatibility mode:

```text
 ┌─────────────────────────────────────────────────────────────────────────────────────────────┐
 │                      SCHEMA COMPATIBILITY MODES COMPARISON                                  │
 ├──────────────┬────────────────────────────────────────────────────────┬─────────────────────┤
 │ Mode         │ Meaning                                                │ Upgrade Order       │
 ├──────────────┼────────────────────────────────────────────────────────┼─────────────────────┤
 │ BACKWARD     │ New schema can read data produced by OLD schema.       │ Consumers FIRST,    │
 │ (Industry    │ Consumers on schema v2 can read messages from v1.      │ Producers SECOND    │
 │ Standard)    │                                                        │                     │
 ├──────────────┼────────────────────────────────────────────────────────┼─────────────────────┤
 │ FORWARD      │ Old schema can read data produced by NEW schema.       │ Producers FIRST,    │
 │              │ Consumers on schema v1 can read messages from v2.      │ Consumers SECOND    │
 ├──────────────┼────────────────────────────────────────────────────────┼─────────────────────┤
 │ FULL         │ Both BACKWARD and FORWARD compatible simultaneously.   │ Any order           │
 │              │ New reads old, old reads new.                          │                     │
 ├──────────────┼────────────────────────────────────────────────────────┼─────────────────────┤
 │ NONE         │ No checks. Anything can be registered (Chaos!).        │ N/A (Never in prod) │
 └──────────────┴────────────────────────────────────────────────────────┴─────────────────────┘
```

### The Golden Rule of BACKWARD Compatibility
In event-driven architectures with durable message logs (Kafka), **BACKWARD compatibility is the gold standard**:
- An event written to Kafka 3 days ago is stored with Schema v1.
- When an Orders consumer restarts or processes replay events, it must read Schema v1 messages using its new Schema v2 code.

#### What BACKWARD Compatibility Allows vs. Forbids:
| Proposed Schema Change | Allowed? | Why? |
| :--- | :---: | :--- |
| **Add an optional field** (with default value or optional) | **YES** | Old events don't have it; new consumers safely fall back to default or `undefined`. |
| **Delete an existing field** | **YES** | New consumers no longer require it; old events containing it will simply be ignored. |
| **Add a required field** | **NO (REJECTED)** | Old events in Kafka do not have this field! A new consumer expecting it would crash. |
| **Rename a field** (`price` ➔ `priceInCents`) | **NO (REJECTED)** | Equivalent to deleting an old field and adding a new required field simultaneously. |
| **Change a field type** (`number` ➔ `string`) | **NO (REJECTED)** | Breaks consumer type assumptions. |

---

### The Safe Schema Evolution Protocol: "Expand ➔ Migrate ➔ Contract"

How do senior engineers rename a field in a distributed system without downtime?

```text
Phase 1: EXPAND (Producer deploys first)
- Add new optional field `priceInCents` alongside existing `price`.
- Producer populates BOTH `price: 100` and `priceInCents: 10000`.
- Registered as Schema v2 (BACKWARD compatible).

Phase 2: MIGRATE (Consumers deploy next)
- Consumers update their code to read `priceInCents ?? (price * 100)`.
- All consumer services deploy independently.

Phase 3: CONTRACT (Clean up)
- Once 100% of consumers are migrated, deprecate and remove `price` in Schema v3.
```

---

## 4. Layer 2: Consumer-Driven Contract Testing (Pact)

### Why Schema Registry Is Not Enough

The Schema Registry only validates **syntax and structure**. It does not know **what the consumer actually cares about**:

- Suppose `TicketCreated.schema.json` declares `price` as an optional property (`required: ["id", "title"]`).
- From the Schema Registry's perspective, publishing `{ id: "123", title: "Concert" }` without `price` is **100% valid**.
- But the `orders` service logic requires `price` to calculate order totals! If `price` is omitted, `orders` fails at runtime.
- **The Schema Registry cannot catch this because it only checks schema validity, not consumer business requirements.**

This is where **Consumer-Driven Contract (CDC) Testing with Pact** comes in.

---

### The Consumer-Driven Pact Workflow

In traditional integration testing, you deploy all 6 services into a staging Kubernetes cluster and test end-to-end. This is notoriously slow, flaky, expensive, and fails for reasons unrelated to code (network timeouts, pod restarts).

With Consumer-Driven Contracts:
1. **The Consumer (`orders`) defines what it expects:**
   - "When I receive a message on topic `ticket-events` of type `TicketCreated`, I require: `id` (string), `title` (string), and `price` (number > 0)."
   - It runs its actual `TicketCreatedListener` against a simulated message.
   - It outputs a contract file: `pacts/orders-service-tickets-service.json`.
2. **The Provider (`tickets`) verifies it fulfills the contract:**
   - In its own isolated unit test, `tickets` loads `pacts/orders-service-tickets-service.json`.
   - It runs its actual event builder function (`toTicketCreatedEvent(ticket)`).
   - Pact compares the output against Orders' contract expectations.
   - If Tickets removed `price`, **Tickets' unit tests fail immediately on the developer's laptop**, preventing the bad commit from ever reaching the Git branch or cluster!

```text
 [ Consumer: Orders Service Test ]
   └── Defines expectation: { id: like("1"), title: like("VIP"), price: like(50) }
   └── Passes simulated message to TicketCreatedListener
   └── Generates: pacts/orders-service-tickets-service.json

                         │
                         ▼ Committed to repository
 [ Provider: Tickets Service Test ]
   └── Reads: pacts/orders-service-tickets-service.json
   └── Executes: toTicketCreatedEvent(mockTicket)
   └── Pact verifies: Does generated event satisfy all expectations?
       ├── YES ──► Tests Pass (Safe to deploy!)
       └── NO  ──► Tests Fail: "Orders expects 'price', but Tickets provided 'priceInCents'"
```

---

## 5. Architectural Implementation Plan in Our Ticketing Platform

```text
ticketing/
├── common/
│   ├── src/
│   │   ├── events/
│   │   │   ├── schemas/                          <-- JSON Schemas
│   │   │   │   ├── ticket-created.schema.json
│   │   │   │   ├── ticket-updated.schema.json
│   │   │   │   ├── order-created.schema.json
│   │   │   │   ├── order-cancelled.schema.json
│   │   │   │   ├── payment-created.schema.json
│   │   │   │   └── expiration-complete.schema.json
│   │   │   ├── schema-registry.ts                <-- Confluent Registry encode/decode & cache
│   │   │   └── __test__/
│   │   │       └── schema-sync.test.ts           <-- Asserts TS types and JSON Schemas stay in sync
├── infra/k8s/
│   └── observability/
│       └── schema-registry-depl.yaml             <-- Confluent Schema Registry (cp-schema-registry)
├── pacts/                                        <-- Generated Pact JSON Contracts
│   ├── orders-service-tickets-service.json
│   ├── tickets-service-orders-service.json
│   ├── payments-service-orders-service.json
│   └── expiration-service-orders-service.json
```

### Components to Implement:
1. **Confluent Schema Registry Deployment:** Deployed in Kubernetes as `schema-registry-srv:8081`, backed by the KRaft Kafka cluster.
2. **Schema Registry Client in `@mehul-mrtickets/common`:**
   - Connects to `SCHEMA_REGISTRY_URL`.
   - On startup, registers all event schemas with `BACKWARD` compatibility mode.
   - Wire format serializer: Prepends magic byte + schema ID.
   - Wire format deserializer: Inspects magic byte, verifies schema, validates payload, and sends bad events directly to the DLQ.
3. **Payload Builder Functions:**
   - Extract event creation from route handlers into pure mapper functions (`toTicketCreatedEvent`, `toOrderCreatedEvent`) so the exact same logic is tested by Pact and executed in production.
4. **Pact Test Suites:**
   - Consumer tests for all listeners (`orders`, `tickets`, `payments`, `expiration`).
   - Provider verification tests for all event publishers.

---

## 6. Senior Full-Stack (4.5+ Yrs) Interview Talk Tracks

### Q1: "Why not just share a TypeScript npm package for event types across microservices?"
> *"Sharing TypeScript interfaces via an npm package solves compile-time developer ergonomics, but it provides zero runtime safety in microservices. In distributed architectures, services deploy independently, meaning producers and consumers frequently run different versions of that package simultaneously. Furthermore, TypeScript interfaces are completely erased at runtime. If a producer renames a field, both services compile cleanly in isolation, but the consumer receives `undefined` at runtime. True distributed contract safety requires runtime schema validation via a Schema Registry combined with consumer-driven contract tests like Pact."*

### Q2: "Why do you enforce BACKWARD compatibility rather than FORWARD compatibility in Kafka event streams?"
> *"Kafka is a durable commit log where past events remain stored for days or weeks. If a consumer service crashes or scales up, it reads historical messages written by previous versions of the producer. Under BACKWARD compatibility, a new consumer can seamlessly process old messages stored in Kafka. Under FORWARD compatibility, only old consumers could read new messages, which would break event replays and log-compaction consumers."*

### Q3: "How does Consumer-Driven Contract testing compare to End-to-End (E2E) testing environments?"
> *"End-to-End integration environments are slow, expensive to maintain, prone to flaky network timeouts, and provide feedback late in the lifecycle. Consumer-Driven Contract testing with Pact shifts integration testing left. The consumer records its exact expectations in a pact file during unit testing, and the provider verifies it satisfies those expectations during its own fast, isolated unit test suite—completely independent of a live cluster. It eliminates the need for heavyweight staging environments while providing 100% confidence that APIs and event contracts will not break in production."*

---

## 7. Next Steps & Developer Go-Ahead
Review this lesson. Once you are comfortable with:
1. Why TypeScript interfaces alone leave microservices vulnerable to silent runtime contract breaks.
2. The role of Confluent Schema Registry (magic byte, wire format, BACKWARD compatibility, DLQ routing).
3. The role of Pact Consumer-Driven Contracts (preventing breaking changes at test time).

Give the confirmation to begin the Phase 09 implementation!
