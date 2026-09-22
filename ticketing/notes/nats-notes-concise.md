# NATS Streaming Server (STAN) - Concise Quick Reference

A concise summary of core concepts, architecture patterns, Kubernetes deployment, and client configuration covered in Lectures 1–20.

---

## 1. NATS Core vs. NATS Streaming Server (STAN)

| Feature | NATS Core | NATS Streaming Server (STAN) |
| :--- | :--- | :--- |
| **Model** | Fire-and-forget messaging | Event persistence + replay stream |
| **Delivery Guarantee** | At-most-once | At-least-once (with ACKs) |
| **Storage** | None (in-memory transit only) | Memory, flat files, or SQL DBs |
| **Ordering** | No sequence guarantees | Guaranteed message sequence numbering |
| **Client Library** | `nats` | `node-nats-streaming` (`stan` client) |

---

## 2. Kubernetes Deployment Configuration

File: `infra/k8s/nats-depl.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nats-depl
spec:
  replicas: 1
  selector:
    matchLabels:
      app: nats
  template:
    metadata:
      labels:
        app: nats
    spec:
      containers:
        - name: nats
          image: nats-streaming:0.17.0
          args: [
            '-p', '4222',         # Client Port
            '-m', '8222',         # Monitoring HTTP Port
            '-hbi', '5s',         # Heartbeat interval
            '-hbt', '5s',         # Heartbeat timeout
            '-hbf', '2',          # Heartbeat fail limit
            '-SD',                # Enable STAN debugging
            '-cid', 'ticketing'   # Cluster ID
          ]
---
apiVersion: v1
kind: Service
metadata:
  name: nats-srv
spec:
  selector:
    app: nats
  ports:
    - name: client
      protocol: TCP
      port: 4222
      targetPort: 4222
    - name: monitoring
      protocol: TCP
      port: 8222
      targetPort: 8222
```

---

## 3. Port Forwarding & Monitoring

```bash
# Forward both client and monitoring ports from the cluster to localhost
kubectl port-forward deployment/nats-depl 4222:4222 8222:8222
```

### Monitoring HTTP Endpoints (Port 8222):
- **Base info:** `http://localhost:8222/streaming`
- **Connected Clients:** `http://localhost:8222/streaming/clients`
- **Channels & Subscriptions:** `http://localhost:8222/streaming/channels?subs=1`

---

## 4. Client Implementation Snippets

### A. Publisher (`publisher.ts`)
```typescript
import nats from "node-nats-streaming";

console.clear();

// stan = client instance ("NATS" backwards)
const stan = nats.connect("ticketing", "abc", {
    url: "http://localhost:4222"
});

stan.on("connect", () => {
    console.log("Connected to NATS");

    const data = {
        id: "123",
        title: "concert",
        price: 99
    };

    // Data must be serialized to string / JSON
    stan.publish("ticket:created", JSON.stringify(data), () => {
        console.log("Event published");
    });
});
```

### B. Listener (`listener.ts`)
```typescript
import nats, { Message } from "node-nats-streaming";
import { randomBytes } from "node:crypto";

console.clear();

// Use unique client ID for each instance to prevent collisions
const stan = nats.connect("ticketing", randomBytes(4).toString("hex"), {
    url: "http://localhost:4222"
});

stan.on("connect", () => {
    console.log("Connected to NATS");

    stan.on("close", () => {
        console.log("NATS Connection closed!");
        process.exit();
    });

    // The Golden Trio for Subscriptions:
    const options = stan
        .subscriptionOptions()
        .setManualAckMode(true)               // 1. Prevent auto-ACK, wait for explicit msg.ack()
        .setDeliverAllAvailable()             // 2. Fetch past events on brand new subscription
        .setDurableName("orders-service");    // 3. Track processed events by durable ID

    // Queue Group ensures: 
    // - Load balancing across replicas
    // - Durable subscription state is NOT dumped on short restarts
    const subscription = stan.subscribe(
        "ticket:created",
        "orders-service-queue-group",
        options
    );

    subscription.on("message", (msg: Message) => {
        console.log("Message received");

        const data = msg.getData();
        if (typeof data === "string") {
            console.log(`Received event #${msg.getSequence()}: ${data}`);
        }

        // Acknowledge after successful processing
        msg.ack();
    });
});

// Intercept termination/interrupt signals for clean shutdown
process.on("SIGINT", () => stan.close());
process.on("SIGTERM", () => stan.close());
```

---

## 5. Subscription Architecture Cheat-Sheet

| Feature | Code | Purpose |
| :--- | :--- | :--- |
| **Unique Client ID** | `randomBytes(4).toString("hex")` | Prevents "Client ID already registered" error when scaling instances. |
| **Queue Group** | `stan.subscribe(ch, "queue-group", opts)` | Distributes events to **only 1 member** of the group (load balance). Prevents duplicate processing and retains durable subscription history on restarts. |
| **Manual ACK Mode** | `.setManualAckMode(true)` & `msg.ack()` | Disables auto-ack. NATS waits 30s for `msg.ack()`; re-delivers if processing fails or crashes. |
| **Deliver All Available** | `.setDeliverAllAvailable()` | Re-delivers all past historical events when a new subscription is first created. |
| **Durable Subscription** | `.setDurableName("service-name")` | NATS records which events this durable ID has acknowledged. On restart, only missed/unprocessed events are delivered. |
| **Graceful Shutdown** | `process.on('SIGINT', () => stan.close())` | Notifies NATS immediately to stop sending messages to the stopping client without waiting for heartbeat timeouts. |

---

## 6. Solving Distributed Concurrency (Optimistic Concurrency Control)

* **Root Cause of Concurrency Issues:** Events arriving out-of-order due to network lag, variable service processing speeds, crash retries (30s timeout), or service restarts.
* **The Rule of OCC Versioning:**
  1. The **primary service** (e.g., `tickets` service) is the single source of truth and increments `version` on every create/update.
  2. Events include `version` (`version: 1`, `version: 2`, ...).
  3. Consumer services (e.g., `orders` service) only process an update if:
     $$\text{incoming\_version} === \text{current\_db\_version} + 1$$
  4. If out of order, the consumer does **not** call `msg.ack()`. NATS retries the message after 30s once missing predecessor events have arrived.
