# Phase 09 Code Walkthrough: Event Contracts & Schema Registry (Senior MERN Interview Guide)

This guide provides deep architectural reasoning, failure scenarios, and interview talking points for a **Senior Fullstack MERN / Distributed Systems Developer (4.5+ years experience)** explaining how event schemas and consumer-driven contracts work in production.

---

## 1. The Core Problem: Why TypeScript Interfaces Are Not Contracts

### The Junior Answer:
> "We define TypeScript interfaces in `@mehul-mrtickets/common` and import them in `orders` and `tickets`. If the types match, everything is safe."

### The Senior (4.5+ Yrs) Answer:
> "TypeScript interfaces only exist during compile time of that specific service. In a microservices architecture, services deploy independently and asynchronously.
>
> 1. **Version Skew:** If `tickets` deploys v2 with a new required field, but `orders` is still running v1 with cached dependencies, `orders` will crash at runtime. TypeScript compilation in CI checks code in isolation—it does not validate cross-boundary compatibility across time.
> 2. **Type Erasure:** At runtime in Node.js, JavaScript executes raw JSON. Any developer could accidentally write `{ id, title, priceInCents }` instead of `{ id, title, price }`. If the publishing service has a minor typo or omitted field, the compiler won't save downstream consumers from `NaN` or `undefined` runtime database corruptions.
> 3. **Historical Event Replay:** When a new service joins the cluster or when replaying Kafka topics from offset 0, events written 6 months ago under Schema V1 must still deserialize cleanly in a consumer running Schema V3."

---

## 2. Two-Layer Defense: Schema Registry vs. Pact CDC

| Dimension | Confluent Schema Registry | Pact Consumer-Driven Contract Testing (CDC) |
|---|---|---|
| **Phase** | **Runtime** (Serialization & Consumption in Kafka) | **Test-Time / CI Gate** (Pre-deploy Verification) |
| **Enforcement** | Structural schema compatibility (`BACKWARD`, `FORWARD`, `FULL`). | Semantic usage verification (verifies producer sends what consumer actually needs). |
| **Failure Mode** | Producer fails to register non-backward schema; or consumer routes corrupt messages to DLQ. | CI build breaks before any container image is pushed to Docker registry. |
| **Key Insight** | Catches accidental schema breakage and format corruption at runtime. | Prevents silent omissions (e.g., schema allows optional `price`, but consumer logic actually requires it). |

---

## 3. Deep Dive: Confluent Wire Format

Confluent Schema Registry does **not** send raw JSON over Kafka. Every serialized Kafka message follows the Confluent Wire Format:

```text
+----------------+-------------------------------+-----------------------------------------+
| Magic Byte     | 4-Byte Big-Endian Schema ID   | JSON / Avro / Protobuf Encoded Payload  |
| 1 byte (0x00)  | 4 bytes (e.g. 0x00 00 00 05)  | {"id":"t1","title":"Concert",...}       |
+----------------+-------------------------------+-----------------------------------------+
0                1                               5                                         N
```

### Why Magic Byte + Schema ID?
1. **Zero Bandwidth Overhead for Schemas:** Instead of embedding the full JSON schema (hundreds of bytes) in every message, only 5 bytes of header are sent.
2. **Dynamic Deserialization:** The consumer looks at bytes 1–4, checks its in-memory schema cache for ID `5`. If missing, it makes an HTTP call to `schema-registry-srv:8081/schemas/ids/5`, caches the schema, compiles the AJV validator, and validates the remaining bytes.

---

## 4. Architectural Implementation in Our Codebase

### 4.1 Payload Builders (`toTicketCreatedEvent`, `toOrderCreatedEvent`, etc.)
In previous phases, route handlers created inline payload objects:
```ts
// ❌ Dangerous: Inline literal can omit fields without provider test catching it
await new TicketCreatedPublisher().publish({
    id: ticket.id,
    title: ticket.title,
    price: ticket.price,
    userId: ticket.userId,
    version: ticket.version,
});
```

We refactored all services to use centralized payload builders:
```ts
// ✅ Professional: Shared builder used in both production route and provider Pact test
export const toTicketCreatedEvent = (ticket: TicketDoc): TicketCreatedEvent["data"] => ({
    id: ticket.id,
    title: ticket.title,
    price: ticket.price,
    userId: ticket.userId,
    version: ticket.version,
});
```

**Interview Value:** If an engineer deletes `price` from `toTicketCreatedEvent`, the route handler and the Pact provider verification test use the exact same builder. The Pact test immediately fails with:
`Expected $.price to be present, but was missing!`
The deploy is halted before code reaches Kubernetes.

### 4.2 Dead Letter Queue (DLQ) Routing on Schema Validation Error
In `common/src/events/event-consumer.ts`:
```ts
try {
    const parsedData = await schemaRegistry.decode(message.value);
    await this.onMessage(parsedData, metadata);
} catch (err) {
    if (err instanceof SchemaValidationError) {
        // Send poisoned message to Dead Letter Queue to avoid blocking partition
        await this.dlqProducer.send({
            topic: `${this.subject}.DLQ`,
            messages: [{
                key: message.key,
                value: message.value,
                headers: {
                    ...message.headers,
                    "x-dlq-reason": err.message,
                    "x-dlq-timestamp": new Date().toISOString()
                }
            }]
        });
        return; // ACK the offset on the main topic so other messages can proceed!
    }
    throw err; // Transient DB errors will trigger Kafka retry
}
```

---

## 5. Compatibility Rules: BACKWARD vs FORWARD vs FULL

| Mode | Rule | Safe Migration Order |
|---|---|---|
| **BACKWARD** (Default) | Consumers using the *new* schema can read messages written by *old* producers. (You can delete optional fields, or add optional fields with defaults). | **Upgrade Consumers First**, then Producers. |
| **FORWARD** | Consumers using the *old* schema can read messages written by *new* producers. (You can add fields, but cannot delete fields). | **Upgrade Producers First**, then Consumers. |
| **FULL** | Both backward and forward compatible. | Upgrade either in any order. |

### The "Expand and Contract" Pattern (Safe Production Evolution):
To rename a field from `price` to `priceInCents`:
1. **Phase 1 (Expand):** Add `priceInCents` as an *optional* field. Producer writes *both* `price` and `priceInCents`.
2. **Phase 2 (Migrate):** Deploy consumers to read `priceInCents` (falling back to `price` if undefined).
3. **Phase 3 (Contract):** Once all consumers read `priceInCents`, remove `price` from schema and producer payload.
*(Never rename a field in-place in a live Kafka topic!)*
