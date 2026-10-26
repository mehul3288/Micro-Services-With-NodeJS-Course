# Phase 09 Results: Event Contracts (Confluent Schema Registry & Pact CDC)

## Overview & Executive Summary

In Phase 09, we implemented a dual-layer defense system against event contract breakage in our distributed microservices architecture:
1. **Runtime Protection (Confluent Schema Registry):** Confluent Wire Format serialization (`[0x00][4-byte Schema ID][JSON payload]`), strict `BACKWARD` compatibility mode enforcement at registration time, AJV schema validation with automatic routing to Dead Letter Queues (`<topic>.DLQ`) on corrupt or schema-violating events.
2. **Pre-Deploy Verification (Pact Consumer-Driven Contract Testing):** 6 generated consumer contracts verifying actual listener consumption logic against shared payload builder functions across `orders`, `tickets`, `payments`, and `expiration`.

---

## 1. Confluent Schema Registry Architecture

### 1.1 Deployment & Cold-Start Resilience
- **Deployment:** [`infra/k8s/schema-registry-depl.yaml`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/infra/k8s/schema-registry-depl.yaml) using `confluentinc/cp-schema-registry:7.6.0`.
- **Port & Service:** `schema-registry-srv:8081` exposed to the cluster.
- **Linkerd Injection:** Explicitly disabled (`linkerd.io/inject: "disabled"`) to avoid mTLS proxy startup races before Kafka connection.
- **Cold-Start InitContainer:** `wait-for-kafka` initContainer utilizing `apache/kafka:3.9.0` executing `kafka-broker-api-versions.sh --bootstrap-server kafka-0.kafka-srv:9092` before Schema Registry starts.
- **Host Advertisement Fix:** Configured `strategy: { type: Recreate }` and dynamically injected `SCHEMA_REGISTRY_HOST_NAME` from `status.podIP` via Kubernetes Downward API to avoid Kafka coordinator group `schema-registry` leader election conflicts.

### 1.2 Registered Event Schemas
All 8 schemas created in `common/src/events/schemas/`:
1. `ticket:created` (`ticket-created.schema.json`)
2. `ticket:updated` (`ticket-updated.schema.json`)
3. `order:created` (`order-created.schema.json`)
4. `order:cancelled` (`order-cancelled.schema.json`)
5. `payment:created` (`payment-created.schema.json`)
6. `expiration:complete` (`expiration-complete.schema.json`)
7. `refund:requested` (`refund-requested.schema.json`)
8. `payment:refunded` (`payment-refunded.schema.json`)

All schemas enforce Draft-07 JSON Schema validation with `BACKWARD` compatibility.

---

## 2. Shared Common Package Implementation

- **`common/src/events/schema-registry.ts`**:
  - Implements `SchemaRegistryManager` singleton.
  - Pre-compiles AJV validators for instant in-process validation.
  - Automatically connects to Schema Registry (`SCHEMA_REGISTRY_URL`) if present.
  - Enforces `BACKWARD` compatibility mode on subject registration.
  - Encodes payloads into Confluent Wire Format (`0x00` magic byte + 4-byte big-endian schema ID + JSON string buffer).
  - Decodes messages from Kafka, extracting schema ID, and throws `SchemaValidationError` on malformed messages.
- **`common/src/events/event-consumer.ts`**:
  - Automatically catches `SchemaValidationError` during message consumption.
  - Routes invalid messages to `<topic>.DLQ` with error metadata (failed schema, reason, payload timestamp).
- **`common/src/outbox/outbox-relay.ts` & `base-publisher.ts`**:
  - Validates and encodes outgoing payloads via `schemaRegistry.encode(...)` before writing to Kafka.
- **Schema Sync Unit Tests**:
  - 12/12 unit tests pass in `common/src/events/__test__/schema-sync.test.ts`.

---

## 3. Pact Consumer-Driven Contract (CDC) Testing Matrix

We implemented the complete consumer/provider matrix across our asynchronous microservices:

| Consumer | Provider | Expected Messages | Consumer Test Path | Provider Test Path | Verification Status |
|---|---|---|---|---|---|
| **orders** | **tickets** | `ticket:created`, `ticket:updated` | `orders/src/events/listeners/__pact__/ticket-events.pact.test.ts` | `tickets/src/events/__pact__/ticket-events.provider.pact.test.ts` | **PASS (100%)** |
| **tickets** | **orders** | `order:created`, `order:cancelled` | `tickets/src/events/listeners/__pact__/order-events.pact.test.ts` | `orders/src/events/__pact__/order-events.provider.pact.test.ts` | **PASS (100%)** |
| **payments** | **orders** | `order:created`, `order:cancelled`, `refund:requested` | `payments/src/events/listeners/__pact__/order-events.pact.test.ts` | `orders/src/events/__pact__/order-events.provider.pact.test.ts` | **PASS (100%)** |
| **expiration** | **orders** | `order:created` | `expiration/src/events/listeners/__pact__/order-events.pact.test.ts` | `orders/src/events/__pact__/order-events.provider.pact.test.ts` | **PASS (100%)** |
| **orders** | **payments** | `payment:created` | `orders/src/events/listeners/__pact__/payment-events.pact.test.ts` | `payments/src/events/__pact__/payment-events.provider.pact.test.ts` | **PASS (100%)** |
| **orders** | **expiration** | `expiration:complete` | `orders/src/events/listeners/__pact__/expiration-events.pact.test.ts` | `expiration/src/events/__pact__/expiration-events.provider.pact.test.ts` | **PASS (100%)** |

### Generated Pact Files (in `pacts/`):
- `pacts/orders-service-tickets-service.json`
- `pacts/tickets-service-orders-service.json`
- `pacts/payments-service-orders-service.json`
- `pacts/expiration-service-orders-service.json`
- `pacts/orders-service-payments-service.json`
- `pacts/orders-service-expiration-service.json`

---

## 4. Key Architectural Refactoring: Shared Payload Builders

To prevent drift between route handlers and contract verification tests, we eliminated inline object literals in all publisher calls and replaced them with shared event builders:
- `tickets`: [`ticket-event-builders.ts`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/tickets/src/events/builders/ticket-event-builders.ts) (`toTicketCreatedEvent`, `toTicketUpdatedEvent`)
- `orders`: [`order-event-builders.ts`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/orders/src/events/builders/order-event-builders.ts) (`toOrderCreatedEvent`, `toOrderCancelledEvent`, `toRefundRequestedEvent`)
- `payments`: [`payment-event-builders.ts`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/payments/src/events/builders/payment-event-builders.ts) (`toPaymentCreatedEvent`, `toPaymentRefundedEvent`)
- `expiration`: [`expiration-event-builders.ts`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/expiration/src/events/builders/expiration-event-builders.ts) (`toExpirationCompleteEvent`)

If a developer renames, removes, or modifies a field in any builder, the corresponding Provider Pact test fails immediately before code can ever be built or merged.
