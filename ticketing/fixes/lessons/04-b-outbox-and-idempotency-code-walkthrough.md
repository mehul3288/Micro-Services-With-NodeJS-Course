# Phase 04: Complete Code & Architecture Walkthrough (Transactional Outbox & Idempotent Consumers)

> **Purpose of this guide:**
> In Phase 04, we eliminated the **Dual-Write Vulnerability** between MongoDB and Apache Kafka across all microservices.
> This document is your **single, self-contained reference**. You do **not** need to jump between files: every concept, line of code, database index, distributed lease algorithm, and transactional boundary is displayed and explained here step-by-step.

---

## 1. The Big Picture: What Problem Did We Solve?

### The "Dual-Write" Problem Before Phase 04:
Every route that modified database state and published an event suffered from this fatal sequence:

```text
HTTP Request ──► Save Entity to MongoDB (✅ COMMITTED)
                         │
                         ▼
             [💥 Network Blip / Pod Killed / Kafka Down]
                         │
                         ▼
                 Publish to Kafka (❌ FAILED / NEVER SENT)
```

1. **State Divergence:** The order existed in MongoDB, but the event was never published to Kafka.
2. **Silent Failure:** `tickets` never reserved the ticket, `expiration` never set a timeout, and `payments` never knew the order existed.
3. **No Rollback:** MongoDB has already committed. It has no idea the network call to Kafka failed!
4. **The Inverse Flaw:** Swapping the order (publishing to Kafka *first*, then saving to MongoDB) is even worse: if MongoDB rejects the write (validation error, unique key collision), you have published an event for an entity that **does not exist** (phantom event).

---

### The Solution: Transactional Outbox + Idempotent Consumers

```text
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   PRODUCING MICROSERVICE                                    │
│                                                                                             │
│   HTTP Request (POST /api/orders)                                                           │
│        │                                                                                    │
│        ▼                                                                                    │
│   ┌─────────────────────────── ONE MONGODB ACID TRANSACTION ─────────────────────────────┐  │
│   │                                                                                      │  │
│   │  1. Business Collection (e.g. Orders):                                               │  │
│   │     Insert Order { id: "123", status: "created", ticket: "abc" }                     │  │
│   │                                                                                      │  │
│   │  2. OutboxEvents Collection:                                                         │  │
│   │     Insert OutboxEvent { topic: "order-events", key: "abc", payload: "..." }         │  │
│   │                                                                                      │  │
│   │                    ──► BOTH COMMIT TOGETHER OR BOTH ROLL BACK ◄──                    │  │
│   └──────────────────────────────────────────────────────────────────────────────────────┘  │
│                                           │                                                 │
│                   MongoDB WiredTiger WAL  ▼ (Saved on Disk)                                 │
│                                                                                             │
│   ┌──────────────────────────────────────────────────────────────────────────────────────┐  │
│   │   OutboxRelay Background Worker (Async Polling Loop)                                 │  │
│   │   1. Acquires distributed leader lock (`Lease` collection)                           │  │
│   │   2. Reads unpublished outbox rows in oldest-first order                             │  │
│   │   3. Dispatches messages to Kafka broker with partition key ("abc")                  │  │
│   │   4. Updates row to `publishedAt: new Date()`                                        │  │
│   └──────────────────────────────────────────────────────────────────────────────────────┘  │
│                                           │                                                 │
└───────────────────────────────────────────┼─────────────────────────────────────────────────┘
                                            ▼
                                  APACHE KAFKA BROKER
                             Topic: order-events (Partition 2)
                                            │
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   CONSUMING MICROSERVICE                                    │
│                                                                                             │
│   EventConsumer (with deduplicate: true)                                                    │
│        │                                                                                    │
│        ▼                                                                                    │
│   ┌─────────────────────────── ONE MONGODB ACID TRANSACTION ─────────────────────────────┐  │
│   │                                                                                      │  │
│   │  1. ProcessedEvents Collection:                                                      │  │
│   │     Insert { eventId: "uuid-v4", consumerGroup: "tickets-service" }                  │  │
│   │     (If already exists -> Duplicate! E11000 caught -> Abort with 0 side effects)     │  │
│   │                                                                                      │  │
│   │  2. Business Logic Execution:                                                        │  │
│   │     Ticket.findByIdAndUpdate(ticketId, { orderId: "123" }, { session })              │  │
│   │                                                                                      │  │
│   │  3. Optional Chain:                                                                  │  │
│   │     OutboxPublisher writes TicketUpdatedEvent to Outbox (same session!)              │  │
│   │                                                                                      │  │
│   │                     ──► ATOMIC EFFECTIVELY-ONCE GUARANTEE ◄──                        │  │
│   └──────────────────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 1.1 The Mental Model: Real-World Analogy

Think of this like an **Accredited Bank & Courier System**:

| Architectural Role | Who is it in code? | Bank Analogy | Responsibility |
|---|---|---|---|
| **ACID Transaction** | `mongoose.connection.transaction()` | **The Cashier's Locked Vault** | You deposit money (business entity) AND the cashier stamps a courier transfer slip (outbox event) into the logbook in the same physical ledger entry. |
| **Outbox Document** | `OutboxEvent` | **The Courier Slip** | Sits safely in the bank's locked drawer on disk until picked up. |
| **Distributed Lock** | `Lease` | **The Shift Keyring** | Only one courier driver holds the keys to the departure gate at a time, even if 3 drivers are standing in the room. |
| **Relay Runner** | `OutboxRelay` | **The Courier Van** | Constantly checks the drawer every 200ms. Reads pending slips, transports packages to Kafka, and marks the slip "delivered". |
| **Duplicate Tracker** | `ProcessedEvent` | **The Package Delivery Logbook** | When a receiving branch receives a package, they stamp its tracking barcode (`eventId`) into their receipt book. If the same tracking number appears again, they reject it immediately as a duplicate! |
| **Atomic Consumer** | `EventConsumer` (deduplicated) | **The Branch Receiving Clerk** | Records the receipt stamp and updates account balances in the exact same ledger line. If anything goes wrong, the stamp is erased so it can be re-received. |

---

## 2. Deep Dive: The Outbox Event Model (`common/src/outbox/outbox-event.ts`)

Let's examine how the outbox table is structured in MongoDB:

```ts
import mongoose, { Document, Model, Schema } from "mongoose";

export interface OutboxEventAttrs {
    eventId: string;
    topic: string;
    key?: string;
    eventType: string;
    payload: string;
    headers?: Record<string, string>;
}

export interface OutboxEventDoc extends Document {
    eventId: string;
    topic: string;
    key?: string;
    eventType: string;
    payload: string;
    headers?: Record<string, string>;
    publishedAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}
```

### Why these exact fields?
1. **`eventId`**: A unique UUID v4 generated at creation time. This ID travels in Kafka headers and is used by consumers to deduplicate redeliveries!
2. **`topic`**: The target Kafka topic (e.g. `order-events`, `ticket-events`).
3. **`key`**: The Kafka partition key (e.g. `ticket.id`, `order.id`). Guarantees that related events always land on the same partition.
4. **`eventType`**: The event subject (e.g. `order:created`, `ticket:updated`).
5. **`payload`**: JSON-serialized business data.
6. **`headers`**: Kafka headers including `"event-id"`, `"event-type"`, and `"occurred-at"`.
7. **`publishedAt`**: `null` while pending. Populated with `new Date()` as soon as Kafka ACKs the send.

---

### The Two Critical MongoDB Indexes

```ts
// 1. Index for polling pending events efficiently in oldest-first order
outboxEventSchema.index({ publishedAt: 1, _id: 1 });

// 2. TTL index: delete published outbox events after 7 days
outboxEventSchema.index(
    { publishedAt: 1 },
    { expireAfterSeconds: 7 * 24 * 60 * 60, partialFilterExpression: { publishedAt: { $ne: null } } }
);
```

#### Why index `{ publishedAt: 1, _id: 1 }`?
When the relay polls for pending events:
```ts
OutboxEvent.find({ publishedAt: null }).sort({ _id: 1 }).limit(batchSize);
```
Without this index, MongoDB would perform a full collection scan (`COLLSCAN`) over thousands of rows!
With `{ publishedAt: 1, _id: 1 }`, MongoDB jumps directly to the `null` entries in the B-Tree in $O(\log N)$ time, and because `_id` contains an embedded timestamp in ObjectId, it reads them sequentially in chronological order.

#### Why the partial TTL index?
- Standard TTL indexes delete documents when a date expires.
- **The Danger:** If Kafka is down for 8 days, an ordinary TTL index on `createdAt` would delete **unpublished** events!
- **The Solution:** `{ partialFilterExpression: { publishedAt: { $ne: null } } }`.
  MongoDB **only** counts down the 7-day TTL if `publishedAt` is not null. Pending events are **never** deleted by the TTL index until they are safely published!
- 7 days matches our Apache Kafka topic retention period.

---

## 2.1 Architecture FAQ: Did We Create Only ONE Outbox Collection for All Services?

**No. Each microservice has its own separate `outboxevents` collection inside its own private MongoDB database!**

A very common point of confusion is: *"Since `OutboxEvent` model is defined only once in `common`, doesn't that mean there is only one shared collection?"*

Here is how the architecture actually works under the hood:

### 1. Code Blueprint vs. Runtime Isolation
In `@mehul-mrtickets/common`, we defined the **model blueprint** (the TypeScript class):
```ts
export const OutboxEvent = mongoose.model<OutboxEventDoc, OutboxEventModel>(
    "OutboxEvent",
    outboxEventSchema
);
```
This is only a **reusable template**. At runtime in Kubernetes, each service connects to its own independent MongoDB instance:

```text
┌───────────────────────────┐      ┌───────────────────────────┐      ┌───────────────────────────┐
│      TICKETS SERVICE      │      │      ORDERS SERVICE       │      │     PAYMENTS SERVICE      │
│                           │      │                           │      │                           │
│  mongoose.connect(        │      │  mongoose.connect(        │      │  mongoose.connect(        │
│    ".../tickets"          │      │    ".../orders"           │      │    ".../payments"         │
│  )                        │      │  )                        │      │  )                        │
└─────────────┬─────────────┘      └─────────────┬─────────────┘      └─────────────┬─────────────┘
              │                                  │                                  │
              ▼                                  ▼                                  ▼
┌───────────────────────────┐      ┌───────────────────────────┐      ┌───────────────────────────┐
│     TICKETS MONGO DB      │      │      ORDERS MONGO DB      │      │     PAYMENTS MONGO DB     │
│                           │      │                           │      │                           │
│  Collections:             │      │  Collections:             │      │  Collections:             │
│  ├── tickets              │      │  ├── orders               │      │  ├── payments             │
│  ├── outboxevents  ◄──────┤      │  ├── tickets              │      │  ├── orders               │
│  ├── leases               │      │  ├── outboxevents  ◄──────┤      │  ├── outboxevents  ◄──────┤
│  └── processedevents      │      │  ├── leases               │      │  ├── leases               │
│                           │      │  └── processedevents      │      │  └── processedevents      │
└───────────────────────────┘      └───────────────────────────┘      └───────────────────────────┘
```

### 2. Why MUST Each Service Have Its Own Outbox Collection?
**Because a MongoDB transaction cannot cross separate database servers!**

Remember the core goal of the Transactional Outbox:
> We must write the business entity (e.g. an `Order`) and the `OutboxEvent` in the **exact same ACID transaction**.

If `orders` tried to write to a centralized shared database:
1. `order.save({ session })` would execute in `orders-mongo`.
2. `outboxEvent.save({ session })` would execute in `central-mongo`.
3. MongoDB would throw an error! You cannot execute an atomic single-session transaction across two different MongoDB database clusters without distributed Two-Phase Commit (2PC).

Because `orders` has its own private `outboxevents` collection right inside the `orders` database, both collections reside on the **same WiredTiger storage engine** and commit atomically to the **same journal**.

### 3. Step-by-Step: How Mongoose Creates the Collection in a Service

1. **`peerDependencies`:** In `common/package.json`, `mongoose` is declared as a peer dependency. That means `common` does NOT bundle its own separate Mongoose instance; it shares the exact same Mongoose singleton loaded by the microservice.
2. **Connection Binding:** When `orders/src/index.ts` starts, it calls:
   ```ts
   await mongoose.connect(process.env.MONGO_URI); // mongodb://orders-mongo.../orders
   ```
   This attaches `mongoose.connection` to the `orders` database.
3. **Model Initialization:** When `orders` imports `OrderCreatedPublisher`, Mongoose registers `"OutboxEvent"`. Mongoose pluralizes this name to `"outboxevents"` and binds it to `mongoose.connection`.
4. **On-Demand Disk Creation:** MongoDB is schema-less and creates collections dynamically. The very first time `await outboxEvent.save({ session })` executes, MongoDB automatically creates `orders.outboxevents` on disk and builds the `{ publishedAt: 1, _id: 1 }` index.

| Stage | In `tickets` process | In `orders` process | In `payments` process |
|---|---|---|---|
| **Startup Connect** | `.../tickets` | `.../orders` | `.../payments` |
| **Model Binding** | `tickets` connection | `orders` connection | `payments` connection |
| **First `publish()`** | Inserts into `tickets.outboxevents` | Inserts into `orders.outboxevents` | Inserts into `payments.outboxevents` |
| **Isolation** | Only visible to `tickets` relay | Only visible to `orders` relay | Only visible to `payments` relay |

---

## 3. Deep Dive: `OutboxPublisher` (`common/src/outbox/outbox-publisher.ts`)

In Phase 03, a publisher held a reference to `kafkaWrapper.producer` and sent bytes over TCP.
In Phase 04, `OutboxPublisher` does **not** touch the network at all:

```ts
import { ClientSession } from "mongoose";
import { randomUUID } from "crypto";
import { Subjects } from "../events/subjects";
import { topicFor } from "../events/topics";
import { OutboxEvent, OutboxEventDoc } from "./outbox-event";

interface Event {
    subject: Subjects;
    data: any;
}

export abstract class OutboxPublisher<T extends Event> {
    abstract subject: T["subject"];
    abstract partitionKey(data: T["data"]): string;

    async publish(data: T["data"], session?: ClientSession): Promise<OutboxEventDoc> {
        const topic = topicFor[this.subject];
        const eventId = randomUUID();

        const outboxEvent = OutboxEvent.build({
            eventId,
            topic,
            key: this.partitionKey(data),
            eventType: this.subject,
            payload: JSON.stringify(data),
            headers: {
                "event-id": eventId,
                "event-type": this.subject,
                "occurred-at": new Date().toISOString(),
            },
        });

        await outboxEvent.save({ session });
        return outboxEvent;
    }
}
```

### Notice:
1. When you call `await new OrderCreatedPublisher().publish(data, session)`, you pass the `ClientSession`.
2. `outboxEvent.save({ session })` commits **inside the same MongoDB ACID transaction** as your entity.
3. If the database crashes, both roll back. If it succeeds, both are persisted.

---

## 4. Deep Dive: Distributed Leader Election (`common/src/outbox/lease.ts`)

In production on Kubernetes, you might run 3 replicas of the `orders` service:
- `orders-depl-7c78-pod-1`
- `orders-depl-7c78-pod-2`
- `orders-depl-7c78-pod-3`

If all 3 pods ran a background polling loop reading `{ publishedAt: null }`, they would fight over the same rows, produce race conditions, and spam Kafka with duplicate messages.
To prevent this, we need **leader election**: only **one** pod at a time should poll the outbox.

We implement this using a MongoDB collection called `Lease` with an atomic Compare-And-Swap (`findOneAndUpdate`).

---

### 4.1 Where and How is the Lease Being Triggered?

The lease is **not** something configured manually in a configuration file. It is executed **automatically in the background** by the `OutboxRelay`!

In each service's startup (`orders/src/index.ts`, `tickets/src/index.ts`, `payments/src/index.ts`):
```ts
const outboxRelay = new OutboxRelay(kafkaWrapper.producer, {
    pollIntervalMs: 200,
    batchSize: 50,
});
outboxRelay.start();
```

When `outboxRelay.start()` runs, it initiates an asynchronous loop running every 200ms:

```ts
// common/src/outbox/outbox-relay.ts
async poll(): Promise<number> {
    // 1. Every 200ms, ask MongoDB: "Am I the leader right now?"
    const isLeader = await acquireLease(this.leaseName, this.holderId);

    if (!isLeader) {
        return 0; // Another replica holds the lease; sleep and yield!
    }

    // 2. Only the ONE active leader pod reaches this line and queries the outbox!
    const pending = await OutboxEvent.find({ publishedAt: null })
        .sort({ _id: 1 })
        .limit(this.batchSize);
    ...
}
```

---

### 4.2 What Does the Lease Look Like in MongoDB?

Inside each service's database (e.g. `orders`), MongoDB maintains a collection named **`leases`** containing just **one single document**:

```json
{
  "_id": "outbox-relay-lease",
  "holder": "orders-depl-pod-abc123",
  "expiresAt": "2026-10-15T20:55:10.000Z",
  "updatedAt": "2026-10-15T20:55:00.000Z"
}
```
- `_id`: The unique name of the lock (`"outbox-relay-lease"`).
- `holder`: The identity of the pod (e.g. `process.env.HOSTNAME` or a random UUID).
- `expiresAt`: The exact timestamp when this lease will expire (10 seconds into the future).

---

### 4.3 The Complete Code: `common/src/outbox/lease.ts`

```ts
import mongoose, { Document, Model, Schema } from "mongoose";

export interface LeaseDoc extends Document<string> {
    _id: string;
    holder: string;
    expiresAt: Date;
    updatedAt: Date;
}

export interface LeaseModel extends Model<LeaseDoc> {}

const leaseSchema = new Schema(
    {
        _id: { type: String, required: true },
        holder: { type: String, required: true },
        expiresAt: { type: Date, required: true },
    },
    { timestamps: true }
);

export const Lease = mongoose.model<LeaseDoc, LeaseModel>("Lease", leaseSchema);

export async function acquireLease(
    leaseName: string,
    holderId: string,
    ttlMs = 10000 // 10 seconds
): Promise<boolean> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);

    try {
        const lease = await Lease.findOneAndUpdate(
            {
                _id: leaseName,
                $or: [
                    { expiresAt: { $lt: now } }, // Condition 1: Old lease expired; claimable
                    { holder: holderId },        // Condition 2: We already own it; renew heartbeat
                ],
            },
            {
                $set: {
                    holder: holderId,
                    expiresAt,
                },
            },
            {
                upsert: true,
                returnDocument: "after",
            }
        );

        return lease?.holder === holderId;
    } catch (err: any) {
        // E11000 duplicate key race on upsert means another replica won the lease
        return false;
    }
}
```

---

### 4.4 How the Code Works Across 4 Real-World Scenarios

#### Scenario A: Cold Start (The collection is completely empty)
1. **Pod 1** calls `acquireLease("outbox-relay-lease", "pod-1")`.
2. MongoDB checks if a document exists with `_id: "outbox-relay-lease"`. It finds nothing.
3. Because `{ upsert: true }` is enabled, MongoDB creates the document with `holder: "pod-1"` and `expiresAt: now + 10s`.
4. `lease.holder === "pod-1"` evaluates to **`true`**.
5. **Pod 1 becomes the active leader.**

#### Scenario B: Pod 2 Starts Up 1 Second Later and Competes
1. **Pod 2** calls `acquireLease("outbox-relay-lease", "pod-2")`.
2. MongoDB checks the query filter:
   - `_id: "outbox-relay-lease"` matches Pod 1's document.
   - But look at the `$or` conditions:
     - `expiresAt < now`? **False** (Pod 1's lease still has 9 seconds remaining).
     - `holder === "pod-2"`? **False** (the active holder is `"pod-1"`).
3. Neither condition matches! MongoDB finds 0 matching documents.
4. Because of `{ upsert: true }`, MongoDB attempts to insert a *new* document with `_id: "outbox-relay-lease"`.
5. **💥 Primary Key Conflict!** MongoDB's `_id` index rejects the insert with an **`E11000 Duplicate Key Error`**.
6. The `catch (err)` block catches `E11000` and immediately returns **`false`**.
7. Pod 2 skips polling and sleeps. **Pod 1 remains the sole leader.**

#### Scenario C: Pod 1 Running Normally (The Heartbeat Renewal)
1. Every 200ms, Pod 1 runs `acquireLease` again.
2. In the query filter, Condition 2 matches: `{ holder: "pod-1" }`!
3. MongoDB atomically updates `expiresAt` to `now + 10s`.
4. As long as Pod 1 is alive, it continuously extends its 10-second lease window (heartbeat).

#### Scenario D: Pod 1 Crashes or is Terminated (`kubectl delete pod`)
1. Pod 1 abruptly dies. It stops sending heartbeats.
2. 10 seconds elapse. Now `now > expiresAt`. The lease is officially **expired**.
3. **Pod 2** calls `acquireLease("outbox-relay-lease", "pod-2")`:
   - In the filter, Condition 1 matches: `{ expiresAt: { $lt: now } }`!
   - MongoDB atomically updates `holder: "pod-2"` and sets a fresh 10s expiration.
4. `lease.holder === "pod-2"` returns **`true`**.
5. **Pod 2 seamlessly takes over as the new leader.** Zero human intervention required!

---

### 4.5 Visual State Diagram: Leader Heartbeat & Failover

```text
       POD 1 (Leader)                                      POD 2 (Standby)
             │                                                   │
 Every 200ms:│                                       Every 200ms:│
             ▼                                                   ▼
┌─────────────────────────┐                         ┌─────────────────────────┐
│ acquireLease()          │                         │ acquireLease()          │
│ Matches: holder=pod-1   │                         │ Matches: NOTHING        │
│ Result: ✅ TRUE         │                         │ Result: ❌ FALSE        │
└────────────┬────────────┘                         └────────────┬────────────┘
             │                                                   │
             ▼                                                   ▼
Queries Outbox & Publishes                          Does nothing (sleeps 200ms)

───────────────────────────────────────────────────────────────────────────────
💥 POD 1 CRASHES (pod killed or node failure)
───────────────────────────────────────────────────────────────────────────────
             │                                                   │
    [ Pod 1 is Dead ]                                            │
    No heartbeats sent                                           │ 10 seconds pass...
    Lease expires!                                               ▼
                                                    ┌─────────────────────────┐
                                                    │ acquireLease()          │
                                                    │ Matches: expiresAt < now│
                                                    │ Result: ✅ TRUE         │
                                                    └────────────┬────────────┘
                                                                 │
                                                                 ▼
                                                    POD 2 BECOMES THE NEW LEADER!
```

### Why this is mathematically sound:
- **Zero Extra Infrastructure:** No Redis, Consul, or ZooKeeper clusters to operate.
- **Atomic Compare-And-Swap (CAS):** MongoDB's storage engine evaluates `findOneAndUpdate` atomically at the row lock level, making race conditions impossible.
- **Self-Healing:** If a leader dies, standby pods take over automatically after the 10-second TTL expires.

---

## 5. Deep Dive: The Outbox Relay Engine (`common/src/outbox/outbox-relay.ts`)

`OutboxRelay` is the engine that bridges MongoDB to Apache Kafka:

```ts
export class OutboxRelay {
    private isRunning = false;
    private timer?: NodeJS.Timeout;
    private readonly instanceId = randomUUID();

    constructor(
        private producer: Producer,
        private options: OutboxRelayOptions = {}
    ) {}

    start(): void {
        this.isRunning = true;
        this.scheduleNext(0);
    }

    private async poll(): Promise<void> {
        // Step 1: Attempt to acquire or renew leader lease
        const isLeader = await Lease.acquire(
            this.leaseName,
            this.instanceId,
            this.leaseTtlMs
        );

        if (!isLeader) {
            return; // Not the leader; another pod is handling dispatching
        }

        // Step 2: Fetch batch of unpublished rows in oldest-first order
        const events = await OutboxEvent.find({ publishedAt: null })
            .sort({ _id: 1 })
            .limit(this.batchSize);

        if (events.length === 0) {
            return;
        }

        // Step 3: Dispatch to Kafka Broker and Mark Published
        for (const event of events) {
            const rawHeaders = event.headers;
            const cleanHeaders: Record<string, string> = {};

            if (rawHeaders) {
                if (rawHeaders instanceof Map) {
                    for (const [k, v] of rawHeaders.entries()) {
                        cleanHeaders[k] = String(v);
                    }
                } else if (typeof rawHeaders === "object") {
                    for (const [k, v] of Object.entries(rawHeaders)) {
                        cleanHeaders[k] = String(v);
                    }
                }
            }

            cleanHeaders["event-id"] = event.eventId;
            cleanHeaders["event-type"] = event.eventType;
            cleanHeaders["occurred-at"] = event.createdAt ? event.createdAt.toISOString() : new Date().toISOString();

            // 1. Send to Kafka broker
            await this.producer.send({
                topic: event.topic,
                messages: [
                    {
                        key: event.key,
                        value: event.payload,
                        headers: cleanHeaders,
                    },
                ],
            });

            // 2. Mark published immediately upon Kafka ACK
            event.set({ publishedAt: new Date() });
            await event.save();
            publishedCount++;
        }
    }
}
```

### 5.1 Deep Dive: What Happens at Lines 101–115 (The Dispatch & Mark Step)?

```ts
await this.producer.send({
    topic: event.topic,
    messages: [
        {
            key: event.key,
            value: event.payload,
            headers: cleanHeaders,
        },
    ],
});

event.set({ publishedAt: new Date() });
await event.save();
```

Let's trace why this exact sequence is so critical:

1. **Synchronous Acknowledgment (`await this.producer.send`):**
   - The relay does **not** assume the event was delivered.
   - It awaits the Kafka broker's TCP response. Kafka only ACKs once the message has been appended to the topic partition commit log according to the topic's replication settings (`acks: -1` / `acks: all`).
2. **Atomic Status Transition (`event.set({ publishedAt: new Date() })`):**
   - Populating `publishedAt` removes this row from the next 200ms polling query (`{ publishedAt: null }`).
   - It also **activates the 7-day TTL index** (`{ expireAfterSeconds: 604800, partialFilterExpression: { publishedAt: { $ne: null } } }`). The database will now automatically garbage collect this document 7 days from now.
3. **What if the Pod Dies Between `producer.send` and `event.save()`?**
   - This is the classic distributed systems edge case: Kafka received the message, but the pod crashed before marking `publishedAt` in MongoDB!
   - On pod restart (or when another replica acquires the lease), the event is still `{ publishedAt: null }`.
   - The relay will pick it up and **re-send it to Kafka**.
   - **This is why the outbox is an "at-least-once" guarantee.**
   - And this is why **Consumer Deduplication (`ProcessedEvent`)** on the receiving side is mandatory! The receiving service will see the duplicate `eventId`, catch the `E11000` duplicate key, and safely discard it with 0 side effects.

### Why this design is bulletproof:
1. **Oldest-First FIFO:** `.sort({ _id: 1 })` ensures event sequences (e.g. `OrderCreated` before `OrderCancelled`) are preserved.
2. **Crash Resilience:** If the pod crashes while sending event #3 of 5, events #1 and #2 are already marked `publishedAt`. When the pod restarts, it resumes from event #3.
3. **Partition Key Integrity:** `event.key` is passed to `producer.send(...)`, guaranteeing that Kafka's `murmur2(key)` maps the event to the correct partition.

---

## 6. Deep Dive: Consumer Deduplication (`common/src/events/event-consumer.ts`)

Because the outbox guarantees **at-least-once** delivery, network timeouts or pod restarts can occasionally cause a message to be sent twice.
How do we ensure that receiving a duplicate event does not create duplicate effects?

We use the **`ProcessedEvent` Model**:

```ts
const processedEventSchema = new Schema<ProcessedEventDoc>({
    eventId: { type: String, required: true },
    consumerGroup: { type: String, required: true },
    processedAt: { type: Date, default: Date.now },
});

// Compound unique index: guarantees no group processes the same event twice
processedEventSchema.index({ eventId: 1, consumerGroup: 1 }, { unique: true });

// TTL index: 7 days matching Kafka retention
processedEventSchema.index({ processedAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });
```

### The Atomic Consumer Transaction

In `EventConsumer.ts`:

```ts
if (this.deduplicate && this.connection) {
    try {
        await this.connection.transaction(async (session) => {
            // 1. Atomically record that we are processing this event
            await ProcessedEvent.create(
                [{ eventId, consumerGroup: this.consumerGroup }],
                { session }
            );

            // 2. Execute listener business logic with the SAME session
            await listener.onMessage(parsedData, {
                ...metadata,
                session,
            });
        });
    } catch (err: any) {
        // E11000 Duplicate Key Error: Event already processed!
        if (err?.code === 11000) {
            console.warn(`[EventConsumer] Duplicate event ${eventId} detected. Skipping.`);
            return; // Acknowledge and skip safely!
        }
        throw err; // Real error: roll back both and retry
    }
}
```

### Why this is mathematically sound:
1. **Duplicate Arrival:** If Kafka redelivers `eventId: "uuid-1"`, MongoDB immediately rejects `ProcessedEvent.create()` with error `code: 11000`. The transaction aborts instantly, and the listener is never invoked twice!
2. **Listener Failure:** If your listener throws an error (e.g., ticket not found, validation error), MongoDB rolls back the transaction. This also **rolls back the `ProcessedEvent` record**, which means the event is NOT marked as processed and can be retried!

---

## 7. Concrete Service Code Walkthroughs

### 7.1 Producer Route Walkthrough: `orders/src/routes/new.ts`

```ts
router.post(
    "/api/orders",
    requireAuth,
    [ body("ticketId").notEmpty().isMongoId() ],
    validateRequest,
    async (req: Request, res: Response) => {
        const { ticketId } = req.body;
        const ticket = await Ticket.findById(ticketId);
        if (!ticket) throw new NotFoundError();

        const expiration = new Date();
        expiration.setSeconds(expiration.getSeconds() + EXPIRATION_WINDOW_SECONDS);

        let orderDoc: any;

        // ─── START SINGLE MONGODB TRANSACTION ────────────────────────
        await mongoose.connection.transaction(async (session) => {
            const order = Order.build({
                userId: req.currentUser!.id,
                status: OrderStatus.Created,
                expiresAt: expiration,
                ticket: ticket,
            });

            // 1. Atomic reservation inside the transaction
            const reservedTicket = await Ticket.reserve(ticket.id, order.id, session);
            if (!reservedTicket) {
                throw new BadRequestError("Ticket is already reserved");
            }

            // 2. Save order document inside the transaction
            await order.save({ session });

            // 3. Write outbox event inside the transaction
            await new OrderCreatedPublisher().publish({
                id: order._id.toHexString(),
                status: order.status,
                userId: order.userId,
                expiresAt: order.expiresAt.toISOString(),
                version: order.version,
                ticket: {
                    id: ticket.id,
                    price: ticket.price,
                },
            }, session);

            orderDoc = order;
        });
        // ─── TRANSACTION COMMITTED TO DISK ──────────────────────────

        // Respond to user immediately! Kafka dispatch happens asynchronously via OutboxRelay.
        res.status(201).send(orderDoc);
    }
);
```

---

### 7.2 Payments Route Walkthrough: `payments/src/routes/new.ts`

Payments requires a special sequence because Stripe is an external third-party API that **cannot be rolled back** by a database transaction.

```ts
// 1. Call Stripe API FIRST with idempotency key
const charge = await stripe.charges.create(
    {
        currency: "usd",
        amount: Math.round(order.price * 100),
        source: token,
    },
    {
        idempotencyKey: `charge-${orderId}` // Prevents double-charging on network retries
    }
);

// 2. Stripe succeeded! Now commit database state + Outbox atomically
let paymentDoc: any;
try {
    await mongoose.connection.transaction(async (session) => {
        const payment = Payment.build({
            orderId: orderId,
            stripeId: charge.id,
        });

        await payment.save({ session });

        await new PaymentCreatedPublisher().publish({
            id: payment.id,
            orderId: payment.orderId,
            stripeId: payment.stripeId,
        }, session);

        paymentDoc = payment;
    });
} catch (err: any) {
    if (err?.code === 11000) {
        throw new BadRequestError("Order is already paid");
    }
    throw err;
}

res.status(201).send({ id: paymentDoc.id });
```

---

### 7.3 Consumer Listener Walkthrough: `tickets/src/events/listeners/order-created-listener.ts`

```ts
export class OrderCreatedListener extends Listener<OrderCreatedEvent> {
    subject: Subjects.OrderCreated = Subjects.OrderCreated;

    async onMessage(data: OrderCreatedEvent["data"], metadata: EventMetadata): Promise<void> {
        // 1. Find ticket
        const ticket = await Ticket.findById(data.ticket.id).session(metadata.session || null);
        if (!ticket) throw new Error("Ticket not found");

        // 2. Mark reserved
        ticket.set({ orderId: data.id });
        await ticket.save({ session: metadata.session });

        // 3. Publish TicketUpdatedEvent to Outbox inside the exact same session!
        await new TicketUpdatedPublisher().publish({
            id: ticket.id,
            price: ticket.price,
            title: ticket.title,
            userId: ticket.userId,
            orderId: ticket.orderId,
            version: ticket.version,
        }, metadata.session);
    }
}
```

Notice what happens:
1. `EventConsumer` starts the transaction and records `ProcessedEvent`.
2. `OrderCreatedListener` updates the `Ticket` in that transaction.
3. `TicketUpdatedPublisher` inserts a `TicketUpdated` outbox event in that transaction.
4. **All three writes commit in one atomic atomic unit!**

---

## 8. Summary Comparison: Before vs After Phase 04

| Dimension | Before Phase 04 | After Phase 04 |
|---|---|---|
| **Write Reliability** | Dual-write vulnerability: DB and network out of sync on crashes. | **ACID Outbox**: DB mutation and Outbox event commit together or roll back together. |
| **Kafka Dependency** | HTTP request blocked until Kafka ACK'd. If Kafka was down, requests failed. | **Decoupled**: Write path succeeds even if Kafka is down. OutboxRelay drains when Kafka recovers. |
| **Delivery Guarantee** | Best-effort / uncoordinated at-least-once. | **Strict effectively-once**: At-least-once outbox + unique `ProcessedEvent` deduplication. |
| **Multi-Pod Concurrency** | Race conditions on event dispatch. | **Distributed `Lease`**: Single leader actively polls via atomic CAS `findOneAndUpdate`. |
| **Failure Recovery** | Manual database scripting required to reconcile dropped events. | **Autonomous recovery**: Unsent rows remain in DB and are automatically dispatched on restart. |
| **Test Quality** | Mocks asserted whether `producer.send` was called. | **Database Invariants**: Tests assert physical `OutboxEvent` documents in replica sets. |

---

## 9. Interview Cheat Sheet

When asked: *"How do you guarantee consistency between your database and Kafka in microservices?"*

> *"In distributed systems, the Dual-Write problem occurs when you try to update a local database and publish to a message broker sequentially. If the process dies between the two operations, your system enters an inconsistent state.*
> 
> *To solve this, we implemented the **Transactional Outbox Pattern**:*
> *1. Within a single MongoDB ACID transaction, we write the business aggregate and insert an event document into an `OutboxEvents` collection.*
> *2. An asynchronous background worker, `OutboxRelay`, polls pending events and dispatches them to Apache Kafka with domain partition keys.*
> *3. To prevent split-brain among multi-pod deployments, the relay uses a distributed lease backed by MongoDB atomic `findOneAndUpdate`.*
> *4. Because outbox publishing guarantees at-least-once delivery, our `EventConsumer` implements atomic deduplication using a `ProcessedEvents` collection with a unique compound index on `(eventId, consumerGroup)` inside the consumer's transaction.*
> *5. This converts at-least-once transport delivery into **effectively-once** business execution."*

---

## 10. In Short: What to Keep in Mind for Phase 04

### 1. The Core Law (The 10-Second Rule)
> **"Never write to the database and talk to the network sequentially."**  
> If you `await entity.save()` and then `await producer.send()`, a crash or network blip in between creates a **permanent silent failure** (the Dual-Write problem).

### 2. The 4 Golden Invariants (Code Level)
1. **Entity + Outbox in ONE Transaction:**
   ```ts
   await mongoose.connection.transaction(async (session) => {
       await order.save({ session });
       await new OrderCreatedPublisher().publish(data, session); // writes to local Outbox, NOT Kafka!
   });
   ```
   Both commit together to disk, or neither does.
2. **Decoupled Kafka Dispatching:**
   - Your HTTP route **never waits for Kafka**. It returns `201 Created` immediately.
   - The background worker (`OutboxRelay`) polls pending events and delivers them to Kafka asynchronously every 200ms.
   - If Kafka is completely down, **users can still create orders**! Events safely queue up in the outbox and drain automatically when Kafka returns.
3. **Multi-Pod Leader Lock (`Lease`):**
   - Each service has an atomic Compare-And-Swap lock (`Lease`) in MongoDB.
   - Even if you run 10 pod replicas, **only 1 pod at a time polls the outbox**, preventing duplicate polling races.
   - If the leader pod dies, another pod takes over automatically within 10 seconds.
4. **At-Least-Once + Idempotency = Effectively-Once:**
   - Because the outbox guarantees at-least-once delivery, duplicates *will* happen.
   - `EventConsumer` handles this by inserting `(eventId, consumerGroup)` into `ProcessedEvents` in the same transaction as your listener logic.
   - If a duplicate arrives, MongoDB's unique constraint (`E11000`) catches it instantly and skips processing with **zero side effects**.

### 3. The Big Trap to Avoid
- **Did we create one shared database for all outboxes?**  
  **NO.** Each service (`tickets`, `orders`, `payments`) has its own private `outboxevents` collection in its own MongoDB database. Transactions cannot cross separate databases without 2PC.

### 4. Consumer Retry & Offset Commit Rule
- **Success:** Commits `ProcessedEvents` + entity mutations -> exits `eachMessage` -> KafkaJS commits offset.
- **Duplicate:** E11000 caught -> transaction aborted -> exits `eachMessage` -> KafkaJS commits offset (skipped cleanly).
- **Transient Failure:** Transaction aborted -> retries up to 3 times with backoff (`1s`, `2s`) sending `await heartbeat()`.
- **Poison Pill (3 failures):** Message routed to `<topic>.dlq` -> exits `eachMessage` -> KafkaJS commits offset so the consumer moves on and never gets stuck!

