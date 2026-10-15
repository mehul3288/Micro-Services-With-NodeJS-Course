# Phase 03: Complete Code & Architecture Walkthrough (Apache Kafka Migration)

> **Purpose of this guide:**
> In Phase 03, we touched ~82 files across infrastructure, common libraries, and microservices.
> This document is your **single, self-contained reference**. You do **not** need to jump between files: all key architectures, files, code snippets, and execution flows are displayed and explained here step-by-step.

---

## 1. The Big Picture: What Changed?

### Before (NATS Streaming - STAN):
- Every event type was its own separate channel (e.g. `ticket:created`, `order:created`, `order:cancelled`).
- Order across different channels was not guaranteed: `OrderCancelled` could arrive before `OrderCreated` if network timings varied.
- Each listener had transport logic embedded inside it (`msg.ack()`, manual queue group names).
- STAN is deprecated and reaching end-of-life.

### After (Apache Kafka 3.9.0 in KRaft Mode):
- **Topics are grouped by domain aggregate:**
  - `ticket-events` (TicketCreated, TicketUpdated)
  - `order-events` (OrderCreated, OrderCancelled) — **strictly keyed by `ticket.id`**
  - `payment-events` (PaymentCreated)
  - `expiration-events` (ExpirationComplete)
- **Partitions:** Every topic has **3 partitions** to allow up to 3 replica pods per service to process in parallel.
- **Strict Ordering:** Because `order-events` are keyed by `ticket.id`, all order creation and cancellation events for a specific ticket land on the **same partition** and are processed in chronological order.
- **Centralized Consumer (`EventConsumer`):** Listeners only contain pure business logic (`onMessage(data, metadata)`). Retries, consumer heartbeats, and Dead Letter Queue (DLQ) routing are handled transparently.

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                          KUBERNETES CLUSTER                                 │
│                                                                             │
│  [ kafka-statefulset (KRaft) ] : 9092 (PLAINTEXT)                           │
│     ├── ticket-events     (3 partitions) ──► ticket-events.dlq              │
│     ├── order-events      (3 partitions) ──► order-events.dlq               │
│     ├── payment-events    (3 partitions) ──► payment-events.dlq             │
│     └── expiration-events (3 partitions) ──► expiration-events.dlq          │
│                                                                             │
│   TICKETS SERVICE           ORDERS SERVICE              PAYMENTS SERVICE    │
│   ┌──────────────┐         ┌──────────────┐            ┌──────────────┐     │
│   │ KafkaWrapper │         │ KafkaWrapper │            │ KafkaWrapper │     │
│   │ Producer     │         │ Producer     │            │ Producer     │     │
│   │ EventConsumer│         │ EventConsumer│            │ EventConsumer│     │
│   └──────────────┘         └──────────────┘            └──────────────┘     │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 1.1 The Mental Model: Producer vs Publisher vs EventConsumer vs Listener

To keep the architecture crystal clear, think of the system using an **Office Mailroom Analogy**:

| Architectural Role | Who is it in code? | Real-World Analogy | What is their only responsibility? |
|---|---|---|---|
| **Underlying Connection** | **`kafkaWrapper.producer`** | **The Mail Truck** | One shared TCP connection to the Kafka broker per service. Stays connected continuously. |
| **Message Formatter** | **`Publisher`** (e.g. `TicketCreatedPublisher`) | **The Sender Envelope** | A lightweight helper class. Looks up the topic name, extracts the partition key, attaches headers (`event-type`, `event-id`), and hands the payload to the Producer. |
| **Message Broker** | **Apache Kafka** | **The Sorting Facility** | Holds topic partitions on disk. Routes messages deterministically by hashing the key (`murmur2(key) % 3`). |
| **Front-Desk Dispatcher** | **`EventConsumer`** | **The Office Receptionist** | One per pod. Subscribes to needed topics, receives incoming messages, handles 3-attempt retries with heartbeats, isolates poison pills into the Dead Letter Queue (DLQ), and passes healthy messages to the matching Listener. |
| **Specialist Worker** | **`Listener`** (e.g. `TicketCreatedListener`) | **The Desk Specialist** | Pure business logic (`onMessage(data, metadata)`). Contains zero Kafka connection code, zero offset commits, and zero transport boilerplate. Saves or updates database state. |

### Complete Architectural Flow Diagram

```text
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   PRODUCING SERVICE: TICKETS                                │
│                                                                                             │
│   HTTP Request (POST /api/tickets)                                                          │
│        │                                                                                    │
│        ▼                                                                                    │
│   tickets/src/routes/new.ts                                                                 │
│        │                                                                                    │
│        ├─► 1. Saves Ticket to MongoDB                                                       │
│        │                                                                                    │
│        └─► 2. Creates TicketCreatedPublisher(kafkaWrapper.producer)                         │
│                  │                                                                          │
│                  │  - Subject: Subjects.TicketCreated                                       │
│                  │  - Topic: topicFor[subject] ──► "ticket-events"                          │
│                  │  - Partition Key: data.id ("123")                                        │
│                  │  - Headers: { "event-type": "ticket:created", "event-id": "uuid-v4" }     │
│                  │                                                                          │
│                  ▼                                                                          │
│             Shared kafkaWrapper.producer.send()                                             │
└──────────────────────────────────────┬──────────────────────────────────────────────────────┘
                                       │
                                       ▼ (TCP to Kafka Broker)
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                                 APACHE KAFKA BROKER (KRaft)                                 │
│                                                                                             │
│   Topic: ticket-events (3 Partitions)                                                       │
│   Hashing: murmur2(key: "123") % 3  ──► Deterministically routes to Partition 0             │
│                                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────────────────────┐   │
│   │ Partition 0: [TicketCreated("123")] [OrderCreated("123")] [OrderCancelled("123")]  │   │
│   │ Partition 1: ...                                                                    │   │
│   │ Partition 2: [TicketCreated("546")] [OrderCreated("546")]                           │   │
│   └─────────────────────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────┬──────────────────────────────────────────────────────┘
                                       │
                                       ▼ (Consumed by orders-service)
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   CONSUMING SERVICE: ORDERS                                 │
│                                                                                             │
│   EventConsumer (One instance per pod, consumerGroupId: "orders-service")                   │
│        │                                                                                    │
│        ├─► Reads incoming message from Partition 0                                          │
│        ├─► Inspects header: event-type: "ticket:created"                                    │
│        ├─► Parses JSON payload (if invalid syntax ──► routes immediately to DLQ)            │
│        │                                                                                    │
│        ├─► Dispatches to matching registered listener:                                      │
│        │         │                                                                          │
│        │         ▼                                                                          │
│        │    TicketCreatedListener (Specialist Worker)                                       │
│        │         │                                                                          │
│        │         └─► executes onMessage(data): Saves replicated Ticket in orders MongoDB    │
│        │                                                                                    │
│        ├─► Succeeded? ──► Commits Offset in Kafka ✅                                        │
│        │                                                                                    │
│        └─► Failed? ──► Retries up to 3 times (with backoff + heartbeats)                     │
│                        Exhausted? ──► Publishes to "ticket-events.dlq" with error headers    │
│                        ──► Commits Offset (main partition unblocked)                        │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Infrastructure: How Kafka Runs in Kubernetes

We replaced `nats-depl.yaml` with a single, production-grade StatefulSet in [infra/k8s/kafka-statefulset.yaml](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/infra/k8s/kafka-statefulset.yaml).

### Key Highlights of the YAML:
1. **KRaft Mode (No ZooKeeper):** `KAFKA_PROCESS_ROLES: "broker,controller"` allows the single Kafka binary to act as its own Raft metadata controller.
2. **Disabled Auto-Topic Creation:** `KAFKA_AUTO_CREATE_TOPICS_ENABLE: "false"`. Typos in topic names immediately fail loudly rather than silently creating unwanted single-partition topics.
3. **Headless Service:** `kafka-srv:9092` routes traffic directly to `kafka-0.kafka-srv:9092`.

```yaml
# infra/k8s/kafka-statefulset.yaml (Excerpt)
apiVersion: v1
kind: Service
metadata:
  name: kafka-srv
spec:
  clusterIP: None
  selector:
    app: kafka
  ports:
    - name: client
      port: 9092
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: kafka
spec:
  serviceName: kafka-srv
  replicas: 1
  template:
    spec:
      containers:
        - name: kafka
          image: apache/kafka:3.9.0
          env:
            - name: KAFKA_NODE_ID
              value: "0"
            - name: KAFKA_PROCESS_ROLES
              value: "broker,controller"
            - name: KAFKA_CONTROLLER_QUORUM_VOTERS
              value: "0@kafka-0.kafka-srv:9093"
            - name: KAFKA_LISTENERS
              value: "PLAINTEXT://:9092,CONTROLLER://:9093"
            - name: KAFKA_ADVERTISED_LISTENERS
              value: "PLAINTEXT://kafka-0.kafka-srv:9092"
            - name: KAFKA_AUTO_CREATE_TOPICS_ENABLE
              value: "false"
```

In every service deployment (e.g. [infra/k8s/tickets-depl.yaml](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/infra/k8s/tickets-depl.yaml)), we pass the Kafka coordinates:
```yaml
- name: KAFKA_BROKERS
  value: "kafka-0.kafka-srv:9092"
- name: KAFKA_CLIENT_ID
  valueFrom:
    fieldRef:
      fieldPath: metadata.name   # E.g. "tickets-depl-7c74bbcd6b-x8v2j"
```

---

## 3. The Central Library: `@mehul-mrtickets/common@2.0.0`

The core architectural code lives in `common/src/events/`. Every service imports these classes.

### 3.1 Topic Definitions (`common/src/events/topics.ts`)
Maps each event `Subject` to its corresponding Kafka `Topic`:

```ts
// common/src/events/topics.ts
import { Subjects } from "./subjects";

export enum Topics {
    TicketEvents = "ticket-events",
    OrderEvents = "order-events",
    PaymentEvents = "payment-events",
    ExpirationEvents = "expiration-events",
}

export const topicFor: Record<Subjects, Topics> = {
    [Subjects.TicketCreated]: Topics.TicketEvents,
    [Subjects.TicketUpdated]: Topics.TicketEvents,
    [Subjects.OrderCreated]: Topics.OrderEvents,
    [Subjects.OrderCancelled]: Topics.OrderEvents,
    [Subjects.PaymentCreated]: Topics.PaymentEvents,
    [Subjects.ExpirationComplete]: Topics.ExpirationEvents,
};
```

---

### 3.2 Automated Topic Provisioning (`common/src/events/ensure-topics.ts`)
Because `auto.create.topics.enable=false`, topics must exist before producers can send messages. When each service boots up, `ensureTopics()` connects as an Admin client and ensures all 4 topics and their respective `.dlq` topics exist with 3 partitions:

```ts
// common/src/events/ensure-topics.ts
export async function ensureTopics(kafka: Kafka, topics?: string[]): Promise<void> {
    const admin = kafka.admin();
    await admin.connect();

    try {
        const topicsToEnsure = topics || Object.values(Topics);
        const existingTopics = await admin.listTopics();

        const topicConfigs: { topic: string; numPartitions: number; replicationFactor: number }[] = [];

        for (const topic of topicsToEnsure) {
            // Main topic
            if (!existingTopics.includes(topic)) {
                topicConfigs.push({ topic, numPartitions: 3, replicationFactor: 1 });
            }
            // DLQ topic
            const dlqTopic = `${topic}.dlq`;
            if (!existingTopics.includes(dlqTopic)) {
                topicConfigs.push({ topic: dlqTopic, numPartitions: 3, replicationFactor: 1 });
            }
        }

        if (topicConfigs.length > 0) {
            await admin.createTopics({ topics: topicConfigs, waitForLeaders: true });
            console.log(`Kafka topics verified/created: ${topicConfigs.map((t) => t.topic).join(", ")}`);
        }
    } finally {
        await admin.disconnect();
    }
}
```

---

### 3.3 The Base Publisher (`common/src/events/base-publisher.ts`)
In NATS, you published to a channel name without a partition key.
In Kafka, **you must supply a partition key**. The base class enforces this at compile-time:

```ts
// common/src/events/base-publisher.ts
export abstract class Publisher<T extends Event> {
    abstract subject: T["subject"];
    abstract partitionKey(data: T["data"]): string; // MANDATORY!
    protected producer: Producer;

    constructor(producer: Producer) {
        this.producer = producer;
    }

    async publish(data: T["data"]): Promise<void> {
        const topic = topicFor[this.subject];
        await this.producer.send({
            topic,
            messages: [
                {
                    key: this.partitionKey(data),       // Determines the partition
                    value: JSON.stringify(data),        // The JSON payload
                    headers: {
                        "event-id": randomUUID(),       // Unique UUID v4 for deduplication
                        "event-type": this.subject,     // E.g. "order:created" for routing
                        "occurred-at": new Date().toISOString(),
                    },
                },
            ],
        });
        console.log(`Event published to topic ${topic} [${this.subject}]`);
    }
}
```

#### How Kafka Decides the Partition: The Ticket ID Hashing Math

You do **not** have to manually pick partition 0, 1, or 2 in your code. Kafka's internal partitioner handles this automatically using a deterministic hash formula:

$$\text{Partition Number} = \text{murmur2}(\text{key}) \pmod{\text{total partitions}}$$

Because our topics have **3 partitions** (0, 1, 2), let's trace what happens when two different tickets are handled:

```text
Ticket "123" ──► murmur2("123") % 3 = Partition 0
   ├── 1. TicketCreated("123")   ──► lands in Partition 0 (Offset 0)
   ├── 2. OrderCreated("123")    ──► lands in Partition 0 (Offset 1)
   ├── 3. OrderCancelled("123")  ──► lands in Partition 0 (Offset 2)
   └── 4. OrderCreated("123")    ──► lands in Partition 0 (Offset 3)
   (Guaranteed: One consumer reads Partition 0 in strict single-file sequence: 0 → 1 → 2 → 3)

Ticket "546" ──► murmur2("546") % 3 = Partition 2
   ├── 1. TicketCreated("546")   ──► lands in Partition 2 (Offset 0)
   ├── 2. OrderCreated("546")    ──► lands in Partition 2 (Offset 1)
   └── 3. PaymentCreated("546")  ──► lands in Partition 2 (Offset 2)
   (All events for Ticket 546 stay together in Partition 2!)
```

#### Why This Gives Us Both Safety AND Massive Scalability:
1. **Safety per Ticket:** All events modifying Ticket `"123"` line up in Partition 0. It is physically impossible for `OrderCancelled("123")` to run before `OrderCreated("123")`.
2. **Parallelism across Different Tickets:** Ticket `"123"` in Partition 0 and Ticket `"546"` in Partition 2 can be processed **at the exact same microsecond by two different pod replicas** without ever interfering or locking each other!

---

### 3.4 The Base Listener (`common/src/events/base-listener.ts`)
Notice what is gone: **no transport code, no `msg.ack()`, no channel name**.
A listener is now a pure business handler:

```ts
// common/src/events/base-listener.ts
export interface EventMetadata {
    eventId: string;
    occurredAt: string;
}

export abstract class Listener<T extends Event> {
    abstract subject: T["subject"];
    abstract onMessage(data: T["data"], metadata: EventMetadata): Promise<void>;
}
```

---

### 3.5 The Heart of the Migration: `EventConsumer` (`common/src/events/event-consumer.ts`)
Instead of having 4 separate NATS connections per service, each service has **one single `EventConsumer`**.
It provides:
1. **Header-based routing:** Inspects the `event-type` Kafka header to invoke the correct listener.
2. **Safe JSON handling:** If JSON parsing fails (a corrupted message), it routes immediately to DLQ (retrying is useless).
3. **3-Attempt In-Process Exponential Backoff:** If `onMessage` throws:
   - Attempt 1 fails → calls `heartbeat()`, sleeps 1s, calls `heartbeat()`.
   - Attempt 2 fails → calls `heartbeat()`, sleeps 2s, calls `heartbeat()`.
   - Attempt 3 fails → exhausted!
4. **Poison Pill Isolation (DLQ):** Publishes the failed message to `<topic>.dlq` with detailed diagnostic headers:
   - `dlq-error`: The exact error message.
   - `dlq-consumer-group`: E.g. `orders-service`.
   - `dlq-original-topic`: E.g. `ticket-events`.
   - `dlq-failed-at`: Timestamp.
5. **Committed Offset:** Commits the offset so that the healthy messages behind it are **never blocked**.

```ts
// common/src/events/event-consumer.ts (Key Logic)
await this.consumer.run({
    eachMessage: async ({ topic, partition, message, heartbeat }) => {
        const eventType = message.headers?.["event-type"]?.toString() as Subjects | undefined;
        const eventId = message.headers?.["event-id"]?.toString() || "";
        const occurredAt = message.headers?.["occurred-at"]?.toString() || new Date().toISOString();

        if (!eventType || !this.listeners.has(eventType)) {
            return; // Not registered for this event type; ignore safely
        }

        const listener = this.listeners.get(eventType)!;

        // 1. JSON Parse Isolation
        let data: any;
        try {
            data = message.value ? JSON.parse(message.value.toString("utf-8")) : {};
        } catch (err: any) {
            console.error(`Invalid JSON payload for ${eventType} on ${topic}:`, err);
            await this.sendToDlq(topic, message, `JSON parse error: ${err.message}`);
            return; // Offset will commit, unblocking the partition
        }

        // 2. Retry Loop with Heartbeats
        const maxAttempts = 3;
        let lastError: any;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                await listener.onMessage(data, { eventId, occurredAt });
                return; // Successfully processed!
            } catch (err: any) {
                lastError = err;
                if (attempt < maxAttempts) {
                    await heartbeat(); // Keep Kafka consumer group coordinator informed
                    const delayMs = attempt * 1000; // 1s, 2s
                    await new Promise((resolve) => setTimeout(resolve, delayMs));
                    await heartbeat();
                }
            }
        }

        // 3. Exhausted: Send to DLQ
        console.error(`All ${maxAttempts} attempts exhausted for ${eventType} on ${topic}. Sending to DLQ.`);
        await this.sendToDlq(topic, message, lastError?.message || "Processing failed after retries");
    },
});
```

#### How Automatic Topic Subscription Works Behind the Scenes

Notice that in `index.ts`, you never write `consumer.subscribe("order-events")`. How does `EventConsumer` know which topics to listen to?

When you call `await consumer.start()`, it inspects all listeners you registered:

```ts
// common/src/events/event-consumer.ts (Inside start())
const topicsToSubscribe = new Set<string>();

// 1. Loop through all registered listeners
for (const subject of this.listeners.keys()) {
    // 2. Look up the topic map: topicFor[subject]
    const topic = topicFor[subject];
    if (topic) {
        topicsToSubscribe.add(topic);
    }
}

// 3. Automatically subscribe the Kafka consumer to all unique topics
for (const topic of topicsToSubscribe) {
    await this.consumer.subscribe({ topic, fromBeginning: false });
    console.log(`Subscribed consumer [${this.groupId}] to topic: ${topic}`);
}
```

#### Why Does `tickets` Subscribe to `order-events` Instead of `ticket-events`?
- **`tickets` service** produces tickets, so it **publishes** to `ticket-events`. It doesn't need to listen to its own events!
- However, when a customer purchases a ticket, the **`orders` service** creates an order and publishes `OrderCreated` to **`order-events`**.
- The `tickets` service needs to know this so it can lock the ticket (`ticket.orderId = order.id`).
- Therefore, `tickets` registers `OrderCreatedListener` (subject: `order:created`), which maps to `order-events`. `EventConsumer` automatically subscribes `tickets` to `order-events`!

---

#### Scaling Across Pods: Consumer Groups

Inside each Node.js process (pod), there is **exactly 1 `EventConsumer`**.
However, in Kubernetes, you can scale the deployment to multiple pods:

```text
Topic: order-events (3 Partitions: P0, P1, P2)

          ┌───────────────────────────────────┐
          │     Consumer Group: orders-service│
          └─────────────────┬─────────────────┘
                            │
       ┌────────────────────┼────────────────────┐
       ▼                    ▼                    ▼
[ Orders Pod 1 ]     [ Orders Pod 2 ]     [ Orders Pod 3 ]
(1 EventConsumer)    (1 EventConsumer)    (1 EventConsumer)
   Reads: P0            Reads: P1            Reads: P2
```

- **1 Pod Replica:** That single pod's `EventConsumer` reads Partitions 0, 1, and 2.
- **3 Pod Replicas:** Kafka's group coordinator automatically divides the partitions:
  - Pod 1 consumes Partition 0
  - Pod 2 consumes Partition 1
  - Pod 3 consumes Partition 2
  - All 3 pods work in parallel, giving 3x the throughput with 0 code changes!
- *(If you scale to 4 pods, the 4th pod will sit idle as a hot standby because a partition can only be read by one consumer in a group).*

---

## 4. Inside the Microservices: How They Initialize & Connect

Let's look at `tickets` (and `orders`, `payments`, `expiration` which follow the exact same pattern).

### 4.1 The Service `KafkaWrapper` (`tickets/src/kafka-wrapper.ts`)
Replaced `nats-wrapper.ts`. Notice that the producer is instantiated with **idempotence enabled**:

```ts
// tickets/src/kafka-wrapper.ts
import { Kafka, Producer } from "kafkajs";

class KafkaWrapper {
    private _kafka?: Kafka;
    private _producer?: Producer;
    private _isConnected = false;

    get kafka(): Kafka {
        if (!this._kafka) throw new Error("Kafka client not initialized");
        return this._kafka;
    }

    get producer(): Producer {
        if (!this._producer) throw new Error("Kafka producer not initialized");
        return this._producer;
    }

    get isConnected(): boolean {
        return this._isConnected;
    }

    async connect(clientId: string, brokers: string[]): Promise<void> {
        this._kafka = new Kafka({ clientId, brokers });
        // idempotent: true prevents duplicate messages if network times out during ack
        this._producer = this._kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
        await this._producer.connect();
        this._isConnected = true;
    }

    async disconnect(): Promise<void> {
        if (this._producer) {
            await this._producer.disconnect();
            this._isConnected = false;
        }
    }
}

export const kafkaWrapper = new KafkaWrapper();
```

---

### 4.2 Bootstrapping in `index.ts` (`tickets/src/index.ts`)
Look at how clean startup and shutdown are:

```ts
// tickets/src/index.ts (Excerpt)
const start = async () => {
    // 1. Connect Kafka producer
    const brokers = process.env.KAFKA_BROKERS!.split(",");
    await kafkaWrapper.connect(process.env.KAFKA_CLIENT_ID!, brokers);

    // 2. Ensure all topics & DLQs exist
    await ensureTopics(kafkaWrapper.kafka);

    // 3. Start EventConsumer with consumer group "tickets-service"
    const consumer = new EventConsumer(kafkaWrapper.kafka, "tickets-service");
    consumer.register(new OrderCreatedListener());
    consumer.register(new OrderCancelledListener());
    await consumer.start();

    // 4. Connect MongoDB & start Express
    await mongoose.connect(process.env.MONGO_URI!);
    const server = app.listen(3000);

    // 5. Graceful shutdown handler
    registerGracefulShutdown(server, [
        async () => { await consumer.disconnect(); },
        async () => { await kafkaWrapper.disconnect(); },
        async () => { await mongoose.disconnect(); },
    ]);
};
```

---

## 5. End-to-End Walkthrough: What Happens in the Code

Let's follow the lifecycle of an order from creation to payment or cancellation.

### Flow 1: User Creates a Ticket
1. User sends `POST /api/tickets` to `tickets` service.
2. `tickets/src/routes/new.ts` saves the ticket in MongoDB:
   ```ts
   const ticket = Ticket.build({ title, price, userId: req.currentUser!.id });
   await ticket.save();
   ```
3. Publishes `TicketCreated` via `TicketCreatedPublisher`:
   ```ts
   export class TicketCreatedPublisher extends Publisher<TicketCreatedEvent> {
       readonly subject = Subjects.TicketCreated;
       partitionKey(data: TicketCreatedEvent["data"]): string {
           return data.id; // Keyed by ticket id
       }
   }
   ```
4. The message lands in `ticket-events`.
5. The `orders` service has registered `TicketCreatedListener`. Its `EventConsumer` picks it up, parses it, and creates a local replicated `Ticket` projection in `orders`'s MongoDB database.

---

### Flow 2: User Buys the Ticket (Order Created)
1. User sends `POST /api/orders` with `ticketId`.
2. `orders/src/routes/new.ts` atomically reserves the ticket in MongoDB (via Phase 02's `Ticket.reserve()`) and saves the order.
3. Orders publishes `OrderCreated` via `OrderCreatedPublisher`:
   ```ts
   // orders/src/events/publishers/order-created-publisher.ts
   export class OrderCreatedPublisher extends Publisher<OrderCreatedEvent> {
       readonly subject = Subjects.OrderCreated;
       partitionKey(data: OrderCreatedEvent["data"]): string {
           // CRITICAL INVARIANT: Keyed by ticket.id, NOT order.id!
           return data.ticket.id;
       }
   }
   ```
4. The message lands in `order-events` on the partition determined by `hash(ticket.id)`.
5. Two services consume this simultaneously:
   - **`expiration` service:** `OrderCreatedListener` adds a Bull job with a 15-minute delay.
   - **`tickets` service:** `OrderCreatedListener` locks the ticket:
     ```ts
     // tickets/src/events/listeners/order-created-listener.ts
     const ticket = await Ticket.findById(data.ticket.id);
     ticket.set({ orderId: data.id }); // Ticket is now locked!
     await ticket.save();
     
     // Publish ticket:updated so other services know it's reserved
     await new TicketUpdatedPublisher(kafkaWrapper.producer).publish({ ... });
     ```

---

### Flow 3: Order Expires or Is Cancelled
1. If the 15 minutes expire, `expiration` service fires `ExpirationComplete` to `expiration-events` (keyed by `orderId`).
2. `orders` consumes `ExpirationComplete` and changes order status to `Cancelled`.
3. `orders` publishes `OrderCancelled`:
   ```ts
   // orders/src/events/publishers/order-cancelled-publisher.ts
   export class OrderCancelledPublisher extends Publisher<OrderCancelledEvent> {
       readonly subject = Subjects.OrderCancelled;
       partitionKey(data: OrderCancelledEvent["data"]): string {
           return data.ticket.id; // Same key: routes to SAME partition as OrderCreated!
       }
   }
   ```
4. `tickets` consumes `OrderCancelled` via `OrderCancelledListener`.
   **Notice the defensive safety check:**
   ```ts
   // tickets/src/events/listeners/order-cancelled-listener.ts
   const ticket = await Ticket.findById(data.ticket.id);

   // DEFENSIVE CHECK:
   // Only clear orderId if this exact cancelling order holds the reservation!
   // Prevents an old cancelled event from clearing a newer reservation!
   if (ticket.orderId !== data.id) {
       console.warn(`Ticket orderId (${ticket.orderId}) does not match cancelling order ${data.id}. Skipping.`);
       return;
   }

   ticket.set({ orderId: undefined }); // Ticket is now released!
   await ticket.save();
   ```

---

### Flow 4: User Pays (Payment Completed)
1. User calls `POST /api/payments` with `token` and `orderId`.
2. `payments` verifies order, charges Stripe with idempotency key, and saves `Payment`.
3. `payments` publishes `PaymentCreated` to `payment-events` (keyed by `orderId`).
4. `orders` consumes `PaymentCreated` and marks the order status as `Complete`.

---

## 6. How Tests & Mocks Work

In tests (e.g. `npm test`), we do not want to spin up a real Kafka broker.
We created `__mocks__/kafka-wrapper.ts` in every service:

```ts
// tickets/src/__mocks__/kafka-wrapper.ts
export const kafkaWrapper = {
    isConnected: true,
    producer: {
        send: jest.fn().mockResolvedValue([]),
    },
    kafka: {},
};
```

When a test verifies that an event was published, it asserts on `kafkaWrapper.producer.send`:
```ts
// tickets/src/routes/__test__/new.test.ts
it("publishes an event", async () => {
    await request(app)
        .post("/api/tickets")
        .set("Cookie", global.signin())
        .send({ title: "Concert", price: 20 })
        .expect(201);

    expect(kafkaWrapper.producer.send).toHaveBeenCalled();
    const sendArgs = (kafkaWrapper.producer.send as jest.Mock).mock.calls[0][0];
    expect(sendArgs.topic).toEqual("ticket-events");
});
```

And for listeners (e.g. `order-created-listener.test.ts`), we don't mock `msg.ack()`. We simply `await listener.onMessage(data, metadata)` and verify the database state changed!

---

## 7. The Operational Replay Tool: `tools/dlq-replay/replay.ts`

When an unhandled error causes a message to land in a DLQ (e.g. `ticket-events.dlq`), fixing the bug in code allows us to replay the dead letters:

```ts
// Usage: ts-node replay.ts ticket-events
const dlqTopic = `${topic}.dlq`;
const targetTopic = topic;

await consumer.run({
    eachMessage: async ({ message }) => {
        // Strip the dlq-* diagnostic headers so it looks clean
        const cleanHeaders = filterDlqHeaders(message.headers);

        // Republish to original topic
        await producer.send({
            topic: targetTopic,
            messages: [{ key: message.key, value: message.value, headers: cleanHeaders }],
        });
    },
});
```

---

## Summary Cheat Sheet: NATS vs Kafka Mapping

| Component | NATS Streaming (Phase 02) | Apache Kafka (Phase 03) |
|---|---|---|
| **Broker** | `nats-streaming` Pod | `kafka-statefulset` (KRaft, 3.9.0) |
| **Connection Wrapper** | `natsWrapper.client` | `kafkaWrapper.producer` & `kafkaWrapper.kafka` |
| **Channels vs Topics** | 6 separate channels (`ticket:created`, ...) | 4 topics (`ticket-events`, `order-events`, ...) with 3 partitions |
| **Ordering** | Subject-level only; races between channels | **Per-partition ordering guaranteed by key** (`ticket.id`) |
| **Publishing** | `client.publish(subject, json, callback)` | `producer.send({ topic, messages: [{ key, value, headers }] })` |
| **Listeners** | Transport-coupled with `msg.ack()` | Decoupled `onMessage(data, metadata)` |
| **Consumer Management** | Separate listener connection per event type | **Single `EventConsumer` per service** with header routing |
| **Failure Recovery** | Redeliveries forever (crashes consumer) | **3 In-process retries with heartbeats → DLQ routing** |
| **Topic Provisioning** | Automatic | Controlled via `ensureTopics` (auto-create disabled) |
