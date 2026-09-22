# NATS Streaming Server (STAN) - Comprehensive Course Notes (Lectures 1–20)

Comprehensive lecture-by-lecture guide covering NATS Streaming Server concepts, Kubernetes deployment, TypeScript client setup, messaging semantics, concurrency management, and subscription options.

---

## Table of Contents
1. [Section 1: Introduction to NATS Streaming Server & K8s Deployment (Lectures 1–2)](#section-1-introduction-to-nats-streaming-server--k8s-deployment-lectures-12)
2. [Section 2: Architecture & NATS vs. Custom Event Bus (Lecture 3)](#section-2-architecture--nats-vs-custom-event-bus-lecture-3)
3. [Section 3: Test Subproject Setup & Port Forwarding (Lectures 4–5)](#section-3-test-subproject-setup--port-forwarding-lectures-45)
4. [Section 4: Publishing & Listening Basics (Lectures 6–8)](#section-4-publishing--listening-basics-lectures-68)
5. [Section 5: Scaling Listeners & Queue Groups (Lectures 9–10)](#section-5-scaling-listeners--queue-groups-lectures-910)
6. [Section 6: Manual Acknowledgement (ACK) Mode (Lecture 11)](#section-6-manual-acknowledgement-ack-mode-lecture-11)
7. [Section 7: Monitoring, Heartbeats & Graceful Shutdown (Lectures 12–13)](#section-7-monitoring-heartbeats--graceful-shutdown-lectures-1213)
8. [Section 8: Concurrency & Distributed Data Failure Scenarios (Lectures 14–16)](#section-8-concurrency--distributed-data-failure-scenarios-lectures-1416)
9. [Section 9: Solving Concurrency with Optimistic Concurrency Control (Lectures 17–18)](#section-9-solving-concurrency-with-optimistic-concurrency-control-lectures-1718)
10. [Section 10: Event Replay, Durable Subscriptions & Deliver All (Lectures 19–20)](#section-10-event-replay-durable-subscriptions--deliver-all-lectures-1920)

---

## Section 1: Introduction to NATS Streaming Server & K8s Deployment (Lectures 1–2)

### 1.1 Key Terminology Distinction: NATS vs. NATS Streaming Server
* **NATS (Core NATS):** A lightweight, fire-and-forget publish-subscribe messaging system. It does not provide event persistence, message history, sequence numbers, or delivery guarantees.
* **NATS Streaming Server (STAN):** Built on top of NATS Core. It is an event streaming layer that adds message persistence, sequence numbers, replay capabilities, at-least-once delivery, and durable subscriptions.
* **Important Note:** In official documentation and Docker Hub, always verify you are viewing **NATS Streaming Server** (Docker image: `nats-streaming`), not basic NATS.

```text
┌────────────────────────────────────────────────────────────────────────┐
│                             NATS ECOSYSTEM                             │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │ ⚡ Core NATS                                                   │   │
│   │  • Fire-and-forget messaging                                   │   │
│   │  • In-memory transit only (no storage)                         │   │
│   │  • At-most-once delivery                                       │   │
│   └───────────────────────────────┬────────────────────────────────┘   │
│                                   │ (Built on top of Core NATS)        │
│                                   ▼                                    │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │ 🚀 NATS Streaming Server (STAN)                                │   │
│   │  ├── 💾 Message Persistence (Memory / Flat Files / MySQL / PG) │   │
│   │  ├── 🔢 Guaranteed Sequence Numbering (1, 2, 3...)             │   │
│   │  ├── 🔄 Event Replay & Historical Delivery                     │   │
│   │  ├── 🏷️ Durable Subscriptions                                 │   │
│   │  └── 🛡️ At-Least-Once Delivery Guarantees (via ACKs)          │   │
│   └────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Kubernetes Deployment & Service Manifest (`nats-depl.yaml`)
NATS Streaming is deployed in the cluster using a single Pod deployment and a ClusterIP service exposing both client and monitoring ports.

```text
┌──────────────────────────────────────────────────────────────────────────────────┐
│                             KUBERNETES CLUSTER                                   │
│                                                                                  │
│   ┌──────────────────────────────────────────────────────────────────────────┐   │
│   │ 🛡️ ClusterIP Service: nats-srv (infra/k8s/nats-depl.yaml)                 │   │
│   │   • Client Port:     4222 ──► TargetPort: 4222                           │   │
│   │   • Monitoring Port: 8222 ──► TargetPort: 8222                           │   │
│   │   • Selector:        app: nats                                           │   │
│   └─────────────────────────────────────┬────────────────────────────────────┘   │
│                                         │                                        │
│                                         ▼                                        │
│   ┌──────────────────────────────────────────────────────────────────────────┐   │
│   │ 📦 Pod: nats-depl (Image: nats-streaming:0.17.0)                         │   │
│   │                                                                          │   │
│   │   Startup Arguments:                                                     │   │
│   │     -p 4222          (Client communication port)                         │   │
│   │     -m 8222          (HTTP monitoring dashboard port)                    │   │
│   │     -hbi 5s          (Heartbeat interval: ping client every 5s)          │   │
│   │     -hbt 5s          (Heartbeat timeout: client has 5s to respond)       │   │
│   │     -hbf 2           (Heartbeat fail count before marking dead)          │   │
│   │     -SD              (STAN Debug mode enabled)                           │   │
│   │     -cid ticketing   (Cluster ID for connections)                        │   │
│   └──────────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────────┘
       ▲                                                    ▲
       │ TCP :4222 (Client Traffic)                         │ HTTP :8222 (Monitoring)
┌──────┴──────────────────────────┐                 ┌───────┴────────────────────────┐
│ 🚀 Microservices (Tickets/Orders│                 │ 🌐 Browser Dashboard / Dev Ops │
└─────────────────────────────────┘                 └────────────────────────────────┘
```

#### Command-Line Arguments Breakdown:
- `-p 4222`: Port for client connections.
- `-m 8222`: Port for HTTP monitoring dashboard.
- `-hbi 5s` (Heartbeat Interval): Server pings clients every 5 seconds to check health.
- `-hbt 5s` (Heartbeat Timeout): Clients must respond to heartbeats within 5 seconds.
- `-hbf 2` (Heartbeat Fail Limit): Max consecutive failed heartbeat responses before NATS considers client disconnected.
- `-SD` (STAN Debugging): Enables debug logging output.
- `-cid ticketing`: Cluster ID required for client connections.

---

## Section 2: Architecture & NATS vs. Custom Event Bus (Lecture 3)

### 2.1 Comparison: Custom Event Bus vs. NATS Streaming Server

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ OLD APPROACH: Custom Event Bus (Express + Axios)                                       │
│                                                                                        │
│   [ Ticket Service ] ─── POST /events ──► [ Custom Event Bus (Express) ]               │
│                                                │                                       │
│                        ┌───────────────────────┼───────────────────────┐               │
│                        ▼ (POST /events)        ▼ (POST /events)        ▼ (Echo back!)  │
│               [ Order Service ]       [ Payment Service ]     [ Ticket Service ]       │
│                                                                                        │
│   ❌ Inefficient broadcast to all services, even if irrelevant or the sender itself.  │
└────────────────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────────────────┐
│ NEW APPROACH: NATS Streaming Server (STAN)                                             │
│                                                                                        │
│   [ Ticket Service ] ─── stan.publish('ticket:created') ──► [ NATS Streaming (STAN) ] │
│                                                                    │                   │
│                                                     (Channel: ticket:created)          │
│                                                                    │                   │
│                                                                    ▼ (Delivers ONLY)   │
│                                                           [ Order Service ]            │
│                                                                                        │
│   ✅ Delivers events ONLY to subscribed channels/topics. No broadcast noise.          │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Key Architecture Advantages of STAN:
1. **Specific Channels/Topics:** Services only subscribe to relevant channels (e.g. `ticket:created`) instead of receiving every broadcast.
2. **Persistence Options:** Events are persisted in-memory by default, but can be backed by flat files or databases (MySQL, Postgres) to survive server restarts.
3. **Event-Driven Library:** Uses `node-nats-streaming` with callback/event emitter patterns (`stan.on('connect')`, `stan.publish()`, `subscription.on('message')`).

---

## Section 3: Test Subproject Setup & Port Forwarding (Lectures 4–5)

### 3.1 Project Structure (`nats-test`)
A standalone TypeScript project was created to experiment with NATS Streaming outside Kubernetes before integrating it into services:
- Dependencies: `node-nats-streaming`, `typescript`, `@types/node`, `nodemon`/`ts-node-dev`/`tsx`.
- Scripts: `npm run publish` and `npm run listen`.

### 3.2 Accessing NATS via Port Forwarding
Because the test project runs locally outside the Kubernetes cluster, we use `kubectl port-forward` to map localhost ports directly to the NATS pod.

```text
┌──────────────────────────┐          TCP Request          ┌──────────────────────────┐
│   Host / Local Machine   │ ────────────────────────────► │   kubectl port-forward   │
│     (localhost:4222)     │ ◄──────────────────────────── │   (Background Process)   │
└──────────────────────────┘                               └────────────┬─────────────┘
                                                                        │
                                                         Proxies to Pod │
                                                                        ▼
                                                           ┌──────────────────────────┐
                                                           │     NATS Pod in K8s      │
                                                           │   (nats-depl-xxx:4222)   │
                                                           └──────────────────────────┘
```

```bash
# Get pod name
kubectl get pods

# Forward client and monitoring ports
kubectl port-forward deployment/nats-depl 4222:4222 8222:8222
```

---

## Section 4: Publishing & Listening Basics (Lectures 6–8)

### 4.1 Terminology & Message Lifecycle
- **Subject / Channel:** The topic name identifying the event stream (e.g. `ticket:created`).
- **Stan:** The client instance name convention in NATS Streaming community ("NATS" spelled backward).
- **Message (`msg`):** NATS terminology for an event. Messages must be serialized as strings (e.g. `JSON.stringify()`).

```text
  [ Publisher (Client: abc) ]               [ NATS Streaming Server ]               [ Listener Subscription ]
              │                                         │                                       │
  (1) Publish │  stan.publish('ticket:created', JSON)   │                                       │
      event   ├────────────────────────────────────────►│                                       │
              │                                         │ (2) Stores message &                  │
              │                                         │     assigns sequence # (e.g. #1)      │
              │                                         │                                       │
              │                                         │ (3) Deliver message to channel subs   │
              │                                         ├──────────────────────────────────────►│
              │                                         │                                       │ (4) Receives:
              │                                         │                                       │     - msg.getSubject()
              │                                         │                                       │     - msg.getSequence()
              │                                         │                                       │     - msg.getData()
```

### 4.2 Essential `Message` Methods:
* `msg.getSubject()`: Returns channel name string (`ticket:created`).
* `msg.getSequence()`: Incremental sequence number (1, 2, 3...) assigned by NATS.
* `msg.getData()`: The event payload (`string | Buffer`).

---

## Section 5: Scaling Listeners & Queue Groups (Lectures 9–10)

### 5.1 Client ID Uniqueness
NATS Streaming requires every connected client to have a globally unique `clientID`.
- If two processes connect using the same client ID (e.g. `"123"`), NATS throws `client ID already registered`.
- Resolution for local test instances: `randomBytes(4).toString('hex')`.

### 5.2 Queue Groups
When scaling services horizontally (multiple replicas of Order Service), without a Queue Group, **every replica receives every event**, leading to duplicate processing.

```text
WITHOUT QUEUE GROUP (Duplicate Processing Problem):
──────────────────────────────────────────────────
                               ┌──► [ Order Service (Instance 1) ] (Processes event)
[ NATS: ticket:created ] ──────┤
                               └──► [ Order Service (Instance 2) ] (Processes DUPLICATE event!)


WITH QUEUE GROUP: 'orders-service-queue-group' (Load Balanced):
─────────────────────────────────────────────────────────────
                               ┌─── [ Queue Group ] ───┐
                               │                       │
[ NATS: ticket:created ] ──────┤  (Routes to ONLY ONE  ├──► [ Order Service (Instance 1) ]
                               │   instance per event) │
                               │                       ├──► [ Order Service (Instance 2) ]
                               └───────────────────────┘
```

#### Syntax:
```typescript
// Second argument defines the queue group name
const subscription = stan.subscribe(
    "ticket:created",
    "orders-service-queue-group",
    options
);
```

---

## Section 6: Manual Acknowledgement (ACK) Mode (Lecture 11)

### 6.1 The Risk of Default Auto-ACK
By default, `node-nats-streaming` acknowledges an event immediately upon arrival. If the service crashes, database drops, or processing throws an unhandled error, the event is permanently lost.

### 6.2 Manual ACK Lifecycle
With `.setManualAckMode(true)`, NATS waits for explicit `msg.ack()`. If not received within **30 seconds** (default ACK timeout), NATS re-delivers the event to another instance in the queue group.

```text
  [ NATS Streaming Server ]               [ Order Service (Replica 1) ]           [ Order Service (Replica 2) ]
              │                                         │                                       │
  (1) Deliver │           Event #59                     │                                       │
      Event   ├────────────────────────────────────────►│                                       │
              │                                         │ (Processing fails / DB drops /        │
              │                                         │  service crashes - NO msg.ack())      │
              │                                         │                                       │
  (2) Wait    │ ⏳ 30-Second Timeout Expires!           │                                       │
              │                                                                                 │
  (3) Re-send │                           Re-deliver Event #59 to next group member             │
      Event   ├────────────────────────────────────────────────────────────────────────────────►│
              │                                                                                 │ (Processing
              │                                                                                 │  succeeds!)
              │ (4) Acknowledged: Event #59 marked done!  msg.ack()                             │
              │◄────────────────────────────────────────────────────────────────────────────────┤
```

---

## Section 7: Monitoring, Heartbeats & Graceful Shutdown (Lectures 12–13)

### 7.1 Monitoring Endpoints (`http://localhost:8222/streaming`)
- `/streaming/clients`: Active client connections and IDs.
- `/streaming/channels?subs=1`: Active channels, subscribers, queue groups, and pending ACKs.

### 7.2 The Ghost Subscription Problem & Graceful Shutdown
When a Node process restarts, NATS doesn't immediately know the client died and continues attempting deliveries until heartbeats fail (~10–15s).

```text
  [ Developer / OS ]               [ Node.js Client Process ]               [ NATS Streaming Server ]
          │                                     │                                       │
  (1) Dev stops terminal                        │                                       │
      (SIGINT / SIGTERM)                        │                                       │
          ├────────────────────────────────────►│                                       │
          │                                     │ (2) Intercept signal & call           │
          │                                     │     stan.close()                      │
          │                                     ├──────────────────────────────────────►│
          │                                     │                                       │ (3) Immediately removes
          │                                     │ (4) stan.on('close') triggers         │     subscription from
          │                                     │◄──────────────────────────────────────┤     active routing!
          │                                     │                                       │
          │                                     │ (5) process.exit() - Clean shutdown!   │
```

```typescript
stan.on('close', () => {
    console.log('NATS connection closed!');
    process.exit();
});

process.on('SIGINT', () => stan.close());
process.on('SIGTERM', () => stan.close());
```

### 7.3 What Happens If We DON'T Implement Graceful Shutdown?

If we omit `stan.close()` handlers on process interruption (`SIGINT`/`SIGTERM`), the following severe issues occur:

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ FAILURE FLOW WITHOUT GRACEFUL SHUTDOWN (The "Ghost Subscription" Problem)              │
│                                                                                        │
│  [ Step 1: Dev restarts / kills Service Instance 1 (Ctrl+C) ]                          │
│     └─► Process terminates abruptly WITHOUT notifying NATS.                            │
│                                                                                        │
│  [ Step 2: NATS STILL thinks Instance 1 is alive (Ghost Subscription) ]                │
│     └─► NATS channel monitoring (/streaming/channels?subs=1) shows it as active.       │
│                                                                                        │
│  [ Step 3: Publisher publishes Event #71 ]                                             │
│     └─► NATS routes Event #71 to Dead Instance 1!                                      │
│                                                                                        │
│  [ Step 4: Complete Event Loss / 30-Second Dead Delay ]                                │
│     └─► Event #71 sits in pending status. No one receives or logs it.                  │
│     └─► Only after 30 seconds (ACK timeout) does NATS give up and retry elsewhere.     │
│                                                                                        │
│  [ Step 5: Heartbeat Delay (~10-15s) ]                                                 │
│     └─► NATS takes (hbi * hbf) = 5s * 2 = 10s of failed heartbeats to finally prune    │
│         the dead client. During those 10s, multiple events can get misrouted & lost!   │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Section 8: Concurrency & Distributed Data Failure Scenarios (Lectures 14–16)

In distributed microservices, events can easily arrive out-of-order, be duplicated, or be processed out-of-sequence due to network latency, service restarts, processing speed differences, or timeout retries.

### Example Base: The Banking Application
* Resource: User account balance (Initial balance: **$0**).
* Hard Constraint: Balance can **never** drop below $0.
* Sequence of Events:
  1. Deposit $70
  2. Deposit $40
  3. Withdraw $100

---

### 8.1 Scenario 1: Listener Crash / Transient Failure + 30-Second Timeout Gap

```text
  [ NATS Streaming Channel ]               [ Account Service (A) ]                 [ Account Service (B) ]
              │                                       │                                       │
  (1) Event 1 │ Deposit $70                           │                                       │
              ├──────────────────────────────────────►│ (Crashes / File lock / DB down!       │
              │                                       │  NO acknowledgement sent)             │
              │                                       │                                       │
  (2) Event 2 │ Deposit $40                           │                                       │
              ├──────────────────────────────────────────────────────────────────────────────►│ (Succeeds! Balance = $40)
              │                                                                               │
  (3) Event 3 │ Withdraw $100                                                                 │
              ├──────────────────────────────────────────────────────────────────────────────►│ (Tries $40 - $100 = -$60!)
              │                                                                               │ ❌ CRITICAL BUSINESS ERROR!
              │                                                                               │
              │ ⏳ 30 seconds later Event 1 is retried (Too late!)                            │
              ├──────────────────────────────────────────────────────────────────────────────►│
```

---

### 8.2 Scenario 2: Variable Execution Speed & Overloaded Queue Backlog

```text
  [ NATS Streaming Channel ]               [ Account Service (A - Overloaded) ]    [ Account Service (B - Idle/Fast) ]
              │                                       │                                       │
              │ (Service A has 100 queued tasks)      │                                       │ (Service B queue is empty)
              │                                       │                                       │
  (1) Event 1 │ Deposit $70                           │                                       │
              ├──────────────────────────────────────►│ (Sitting in backlog queue...)         │
              │                                       │                                       │
  (2) Event 2 │ Deposit $40                           │                                       │
              ├──────────────────────────────────────►│ (Sitting in backlog queue...)         │
              │                                       │                                       │
  (3) Event 3 │ Withdraw $100                         │                                       │
              ├──────────────────────────────────────────────────────────────────────────────►│ (Instantly processes Event 3)
              │                                       │                                       │ ❌ Tries $0 - $100 = -$100!
              │                                       │                                       │ (Critical failure before
              │                                       │                                       │  Events 1 & 2 even run!)
```

---

### 8.3 Scenario 3: Laggy I/O Crossing 30-Second Timeout (Duplicate Execution)

```text
  [ NATS Streaming Server ]               [ Account Service (A) ]                 [ Account Service (B) ]
              │                                       │                                       │
  (1) Event 3 │ Withdraw $100 (Balance: $110)         │                                       │
              ├──────────────────────────────────────►│ (Laggy disk: takes 29.99 seconds      │
              │                                       │  to read and calculate balance)       │
              │                                       │                                       │
  (2) 30.00s  │ ⏳ 30-Second ACK Timeout Hit!        │                                       │
              │ (NATS assumes Service A died)         │                                       │
              │                                       │                                       │
  (3) Re-send │ Re-deliver Event 3 ($100 withdraw)    │                                       │
              ├──────────────────────────────────────────────────────────────────────────────►│ (Receives Event 3)
              │                                       │                                       │
  (4) 30.01s  │                                       │ (Service A finishes write!            │
              │                                       │  Balance: $110 - $100 = $10)          │
              │                                       │                                       │
  (5)         │                                       │                                       │ (Service B processes Event 3:
              │                                       │                                       │  Balance: $10 - $100 = -$90!)
              │                                       │                                       │ ❌ DOUBLE DEDUCTION ERROR!
```

---

### 8.4 Why Naive Solutions Fail:
1. **Single Service Instance:** Destroys horizontal scalability; still vulnerable to timeouts/crashes.
2. **Global Sequence in Shared Store:** Serializes all event processing, creating massive bottlenecks across unrelated resources.
3. **Channel per User/Resource:** NATS channel creation overhead makes millions of dynamically created channels infeasible.
4. **Publisher Tracking NATS Sequence:** Publishers do not receive NATS sequence IDs synchronously before dispatch.

---

## Section 9: Solving Concurrency with Optimistic Concurrency Control (Lectures 17–18)

### 9.1 Resource Ownership & Version Numbers
- The primary service that owns the resource (e.g. `tickets` service) is the **single authority** for creating/updating records and incrementing the `version` property.
- Events published include the resource's `version`.

```text
  [ NATS Streaming ]                   [ Orders Service (Instance A) ]         [ Orders Service (Instance B) ]
          │                                           │                                       │
          │ (Events published: V1 Create, V2 Update $50, V3 Update $100)                      │
          │                                           │                                       │
  (1)     │ Event V3 (Ticket Updated to $100)         │                                       │
          ├──────────────────────────────────────────►│                                       │
          │                                           │ Check DB: Current is V1.              │
          │                                           │ Expected V2 (3 - 1).                  │
          │                                           │ ❌ Out-of-Order! Do NOT msg.ack()     │
          │                                           │                                       │
  (2)     │ Event V2 (Ticket Updated to $50)          │                                       │
          ├──────────────────────────────────────────────────────────────────────────────────►│
          │                                                                                   │ Check DB: Current is V1.
          │                                                                                   │ V2 matches (1 + 1)!
          │                                                                                   │ Update DB: price=$50, v=2
          │ (3) msg.ack() for Event V2                                                        │
          │◄──────────────────────────────────────────────────────────────────────────────────┤
          │                                                                                   
  (4)     │ ⏳ 30s Timeout: Re-deliver Event V3        │                                       
          ├──────────────────────────────────────────►│                                       
          │                                           │ Check DB: Current is V2.              
          │                                           │ V3 matches (2 + 1)!                   
          │                                           │ Update DB: price=$100, v=3            
          │ (5) msg.ack() for Event V3                │                                       
          │◄──────────────────────────────────────────┤                                       
```

### 9.2 Rule of Processing:
$$\text{Process if: } \text{event.version} === \text{record.version} + 1$$
If the incoming version does not match, **do not acknowledge the event**. Let NATS re-deliver it after timeout until previous versions are processed.

---

## Section 10: Event Replay, Durable Subscriptions & Deliver All (Lectures 19–20)

### 10.1 The Subscription Options Trio
To support temporary service downtime and new service onboarding without infinite duplicate processing, three options are combined:

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        THE GOLDEN TRIO OF STAN SUBSCRIPTIONS                           │
│                                                                                        │
│   1. .setDeliverAllAvailable()                                                         │
│      └─► Delivers complete event history the VERY FIRST TIME the subscription is created│
│                                                                                        │
│   2. .setDurableName("orders-service")                                                 │
│      └─► NATS records which events this durable client has already acknowledged        │
│          (Prevents re-processing old events on every service restart)                  │
│                                                                                        │
│   3. Queue Group ("orders-service-queue-group")                                        │
│      └─► Prevents NATS from dumping durable subscription state when all instances       │
│          briefly disconnect during restarts or deployments                             │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

```typescript
const options = stan
    .subscriptionOptions()
    .setManualAckMode(true)               // Explicit ACK required
    .setDeliverAllAvailable()             // Catch up on past events on first launch
    .setDurableName("orders-service");    // Persist checkpoint of processed events

const subscription = stan.subscribe(
    "ticket:created",
    "orders-service-queue-group",         // Queue Group protects durable subscription from being dumped
    options
);
```

### Summary of Combined Behavior:
1. **First-ever startup:** `setDeliverAllAvailable()` loads complete event history.
2. **Normal processing:** Events are processed, `msg.ack()` records them under the durable name.
3. **Restarts / Scaling:** NATS remembers acknowledged events for the durable name and **only sends missed/unprocessed events**.
4. **Queue group presence:** Prevents NATS from purging durable subscription tracking during brief total disconnects.
