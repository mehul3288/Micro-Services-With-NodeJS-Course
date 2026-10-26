# Phase 09 Developer Notes: Event Contracts & Schema Registry

## Summary of Completed Changes

### 1. Confluent Schema Registry
- **K8s Config:** [`infra/k8s/schema-registry-depl.yaml`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/infra/k8s/schema-registry-depl.yaml)
- **Host Resolution:** Uses Downward API `status.podIP` for `SCHEMA_REGISTRY_HOST_NAME` and `strategy: { type: Recreate }` to prevent multi-instance host collision.
- **Linkerd Injection:** Disabled via annotation (`linkerd.io/inject: "disabled"`) to avoid proxy initialization conflicts with Kafka broker connectivity.
- **Environment:** Added `SCHEMA_REGISTRY_URL: "http://schema-registry-srv:8081"` to `tickets`, `orders`, `payments`, `expiration`.

### 2. Common Package Updates (`@mehul-mrtickets/common`)
- **JSON Schemas:** 8 schemas in `common/src/events/schemas/`.
- **`SchemaRegistryManager`:** [`common/src/events/schema-registry.ts`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/common/src/events/schema-registry.ts)
  - In-process AJV caching and compilation.
  - Confluent Wire Format (0x00 magic byte + 4-byte schema ID + JSON).
  - Enforces `BACKWARD` compatibility.
- **Consumer Dead Letter Queue:** [`common/src/events/event-consumer.ts`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/common/src/events/event-consumer.ts) routes `SchemaValidationError` to `<topic>.DLQ`.
- **Outbox Relay & Base Publisher:** Outgoing payloads serialized using Confluent Wire Format.
- **Tests:** 12/12 schema sync tests passing.

### 3. Microservice Payload Builders
- `tickets`: [`ticket-event-builders.ts`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/tickets/src/events/builders/ticket-event-builders.ts)
- `orders`: [`order-event-builders.ts`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/orders/src/events/builders/order-event-builders.ts)
- `payments`: [`payment-event-builders.ts`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/payments/src/events/builders/payment-event-builders.ts)
- `expiration`: [`expiration-event-builders.ts`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/expiration/src/events/builders/expiration-event-builders.ts)

### 4. Pact Consumer-Driven Contract Tests
- `@pact-foundation/pact: ^17.1.4` installed in `orders`, `tickets`, `payments`, `expiration`.
- `pacts/` folder at repository root.
- Generated 6 Pact interaction files:
  - `orders-service-tickets-service.json`
  - `tickets-service-orders-service.json`
  - `payments-service-orders-service.json`
  - `expiration-service-orders-service.json`
  - `orders-service-payments-service.json`
  - `orders-service-expiration-service.json`
- All Consumer tests & Provider verification tests verified and passing (100%).

### 5. Disk Management Note
- Drive C: ran low on space due to accumulated Recycle Bin items and temporary cache.
- Emptied Recycle Bin, recovering 2.80 GB.
- When running Jest/Pact tests, invoke directly via `node ./node_modules/jest/bin/jest.js` with `--forceExit` to avoid open handle hanging.
