# Lesson 01 — Infrastructure Foundation: Storage, Lifecycle & Health Probes

> **Phase Goal:** Transform our ephemeral Kubernetes setup into a resilient production foundation: persistent databases that survive pod crashes, single-member replica sets for transactions, liveness/readiness probes to eliminate 502s, and graceful shutdown to drain in-flight traffic during rollouts.

---

## 1. The Big Picture

Imagine you run a restaurant kitchen:
1. **The Ephemeral Whiteboard Problem:** Every time the head chef blinks (the database pod restarts), someone completely erases all open orders and recipes from the whiteboard. That is how MongoDB runs in our cluster today—when a pod restarts, **every ticket, user, order, and payment is permanently wiped out**.
2. **The Sneak-Attack Deployment:** During dinner rush, the owner suddenly pulls the plug on the stove while an expensive steak is half-cooked, immediately tossing it into the trash. That is how deployments work today—Kubernetes terminates our pods with zero warning, cutting connections mid-request and dropping user transactions.
3. **The Unready Waiter:** A new waiter walks out to the dining room before even washing their hands or putting on an apron, immediately takes an order, and drops the plates. That is our pods today—NGINX sends customer traffic before the Node.js app has even connected to MongoDB or NATS!

**Phase 01 builds the bedrock.** Before we write advanced distributed patterns (like the Transactional Outbox or Kafka streams), our containers and databases must be stable, stateful, and observable to Kubernetes.

---

## 2. The Problems in Our Current Code & Manifests

Look at our current Kubernetes files:

### Problem 1: Ephemeral Storage in MongoDB
Look at [infra/k8s/orders-mongo-depl.yaml](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/infra/k8s/orders-mongo-depl.yaml#L1-L18):

```yaml
apiVersion: apps/v1
kind: Deployment        # <-- WRONG for a database
metadata:
  name: orders-mongo-depl
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: orders-mongo
          image: mongo   # <-- No volumeMounts! Writes directly to container disk!
```
* **Failure Mode:** In Kubernetes, containers have ephemeral storage. When `orders-mongo` restarts or Kubernetes reschedules it to another node, the container disk is destroyed. **All data is erased.**
* **Same problem across all 4 databases:** `auth-mongo`, `tickets-mongo`, `orders-mongo`, `payments-mongo`.

### Problem 2: Standalone Mongo Prevents ACID Transactions
* To solve the Dual-Write problem in Phase 04, we need **MongoDB Multi-Document Transactions** (`session.startTransaction()`).
* MongoDB **refuses** to run transactions on a standalone instance. It **mandates** a Replica Set, because transactions rely on MongoDB's replication log (**oplog**).

### Problem 3: Ephemeral Redis in Expiration Service
Look at [infra/k8s/expiration-redis-depl.yaml](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/infra/k8s/expiration-redis-depl.yaml):
* Redis stores Bull's delayed jobs (the 15-minute order countdown).
* If Redis restarts, all delayed jobs are lost. Tickets locked in an expiring order **stay locked forever**.

### Problem 4: No Liveness or Readiness Probes
None of our 12 deployments define `readinessProbe` or `livenessProbe`.
* **Readiness:** When a pod starts, NGINX immediately sends HTTP traffic *before* `mongoose.connect()` completes. The user gets an immediate 500 or 502 error!
* **Liveness:** Remember what we discovered in Phase 00? Nodemon crashed, but Kubernetes kept the container in `1/1 Running`. A proper liveness probe detects when the process stops responding and restarts it automatically.

### Problem 5: Abrupt Shutdown Drops In-Flight Requests
Look at [orders/src/index.ts](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/orders/src/index.ts#L30-L37):

```typescript
natsWrapper.client.on("close", () => {
    console.log("NATS connection closed!");
    process.exit(); // <-- Immediately kills the process!
});
process.on("SIGINT", () => natsWrapper.client.close());
process.on("SIGTERM", () => natsWrapper.client.close());
```
When Kubernetes rolls out a new version or shuts down a pod:
1. It sends a `SIGTERM` signal.
2. The code immediately closes NATS and runs `process.exit()`.
3. Any user currently waiting for an HTTP checkout request has their connection forcibly severed!

---

## 3. Core Concepts

### A. Deployment vs StatefulSet
Why can't we just attach a volume to a regular Kubernetes `Deployment`?

```text
 Deployment:                          StatefulSet:
 ┌──────────────────────┐             ┌──────────────────────┐
 │ Pod: orders-mongo-xyz│             │ Pod: orders-mongo-0  │ (Stable name)
 └──────────────────────┘             └──────────┬───────────┘
   (Random pod name,                             │
    random DNS,                                  ▼
    unpredictable disk)               ┌──────────────────────┐
                                      │ PVC: data-orders-0   │ (Dedicated Persistent Disk)
                                      └──────────────────────┘
```

| Feature | `Deployment` | `StatefulSet` |
|---|---|---|
| **Pod Naming** | Random hash (`orders-mongo-7f599cd56c-jcb62`) | Deterministic index (`orders-mongo-0`) |
| **Network Identity** | Ephemeral IP, unpredictable hostname | Stable DNS (`orders-mongo-0.orders-mongo-srv`) |
| **Storage Binding** | Pods share or detach randomly | Each pod index is permanently bound to its own PVC |
| **Best For** | Stateless apps (Express, Next.js) | Stateful databases (MongoDB, Redis, Kafka) |

### B. PersistentVolumeClaim (PVC)
A `PersistentVolumeClaim` is a formal request for durable disk storage:
* Even if the pod dies or is deleted, the **PersistentVolume stays on disk**.
* When Kubernetes spins up the replacement pod, it mounts the exact same volume back to `/data/db`. Zero data loss!

### C. MongoDB Single-Member Replica Set (The "Undo" Ledger)

#### The Problem: Why Transactions Need an "Undo" Button
Imagine Alice sends $100 to Bob:
* **Step 1:** Subtract $100 from Alice's balance.
* **Step 2:** Add $100 to Bob's balance.

In database terminology, this is **ACID (Atomic)**: either **both** happen, or **neither** happens.
If your server crashes right after Step 1, the database must have an **"Undo" button (Rollback)** to restore Alice's $100.

#### How MongoDB Implements It: The Oplog
MongoDB tracks and rolls back multi-step transactions using a special internal ledger called the **oplog** (Operations Log).
* In a **Standalone MongoDB** instance, the oplog is **turned off** by default.
* The oplog is **ONLY created and active when MongoDB runs as a Replica Set** (because it is the exact same ledger Mongo uses to replicate data across nodes).

Because standalone Mongo has no oplog, MongoDB engineers built a hard safety check into the engine:
> *"No oplog? Then I cannot safely coordinate multi-document rollbacks. I refuse to start transactions."*

```text
 Standalone Mongo:                    Replica Set (rs0):
 ┌──────────────────────┐             ┌──────────────────────┐
 │ MongoDB              │             │ MongoDB              │
 │ ↳ Writes directly    │             │ ↳ Writes to OPLOG    │ ◄── Gives us the
 │   to data files.     │             │ ↳ Enables Rollbacks  │     "Undo" ledger!
 │   NO OPLOG.          │             │ ↳ TRANSACTIONS WORK! │
 └──────────────────────┘             └──────────────────────┘
 ❌ Transactions BLOCKED               ✅ ACID Transactions ALLOWED
```

#### The Production Trick for Local Development
A cloud production cluster typically runs 3 MongoDB replicas per service (Primary, Secondary, Arbiter). Running 3 replicas for all 4 microservices locally would require **12 MongoDB pods** (~8 GB RAM!).

**The Solution:**
We run each MongoDB database as a **1-member replica set** (`--replSet rs0`):
* Uses minimal RAM (only 1 pod per database).
* Still activates the **oplog**, unlocking full ACID transactions and change streams for Phase 04!

---

### D. Redis AOF (Append-Only File) Persistence
By default, Redis keeps data purely in RAM (or saves snapshots every 15 minutes).
With **AOF (`appendonly yes`)**:
* Every single Redis write command is logged to disk in real-time.
* We configure `appendfsync everysec`—at most 1 second of delayed expiration jobs could be lost on total power loss, perfectly balancing performance and durability.

---

### E. Liveness vs Readiness Probes (The Golden Rule)

```text
                ┌───────────────────────────────────────────────┐
                │             KUBERNETES POD CHECKS             │
                └──────────────────────┬────────────────────────┘
                                       │
            ┌──────────────────────────┴──────────────────────────┐
            ▼                                                     ▼
 ┌─────────────────────────────┐               ┌─────────────────────────────┐
 │       READINESS PROBE       │               │       LIVENESS PROBE        │
 │  "Can I receive traffic?"   │               │   "Is my process alive?"    │
 ├─────────────────────────────┤               ├─────────────────────────────┤
 │ Checks: Express server up + │               │ Checks: Process is alive    │
 │ DB and NATS connections OK. │               │ (Lightweight HTTP 200 ping).│
 │                             │               │                             │
 │ If it fails:                │               │ If it fails:                │
 │ Remove pod from Ingress!    │               │ RESTART THE POD!            │
 │ (No traffic sent to it)     │               │ (Fixes hung/dead processes) │
 └─────────────────────────────┘               └─────────────────────────────┘
```

#### Why What Happens on Failure Matters:
* If a **Readiness Probe** fails: Kubernetes simply stops routing HTTP traffic to the pod. The pod stays alive and healthy.
* If a **Liveness Probe** fails: Kubernetes immediately **kills the container and restarts it from scratch!**

#### The "Office Filing Cabinet" Analogy (The Death Spiral Trap)
Imagine an office with **10 workers (10 Express pods)** who all read files from **1 central filing cabinet (MongoDB)**.  
Suddenly, someone drops the key and the cabinet is jammed for 5 seconds.

* **With Readiness Probes (Correct):**  
  The manager tells the 10 workers: *"The cabinet is jammed. Pause taking customer phone calls for 5 seconds until it is unjammed."* The workers wait peacefully. When the cabinet is unjammed, they resume answering calls. No disaster!

* **With Liveness Probes Checking MongoDB (The Disaster):**  
  If the workers check the filing cabinet in their *liveness* probe:
  ```text
   1. MongoDB has a brief 3-second network hiccup.
   2. All 10 Express pods check MongoDB in their Liveness probe.
   3. MongoDB doesn't answer in time -> all 10 pods report "LIVENESS FAILED!"
   4. Kubernetes immediately KILLS AND REBOOTS all 10 pods simultaneously!
   5. All 10 pods reboot at the exact same millisecond and violently hammer
      MongoDB with new connection requests ("Thundering Herd").
   6. MongoDB is overwhelmed and slows down even more!
   7. Liveness fails again -> Kubernetes kills all 10 pods again!
   8. 💥 PERMANENT CLUSTER COLLAPSE (The Death Spiral).
  ```

> [!CAUTION]
> **The Golden Rule:** 
> - **Liveness (`/healthz/live`):** Only checks: *"Is my Node.js process alive and responding to basic HTTP pings?"* **NEVER check MongoDB here.**
> - **Readiness (`/healthz/ready`):** Checks: *"Is my connection to MongoDB and NATS currently open so I can serve real queries?"* Traffic pauses if DB is down, but the pod is never killed.

### F. Graceful Shutdown (The 3-Step Dance)
When Kubernetes shuts down a pod during a new deployment:

```text
 1. Kubernetes removes Pod from Ingress Endpoints (Takes ~3-5 seconds to sync)
 2. preStop Hook: sleep 5  (Keeps process alive while Ingress finishes rerouting traffic)
 3. SIGTERM arrives:
    a. server.close(): Stop accepting NEW HTTP requests
    b. Drain in-flight requests (finish serving active users)
    c. Close NATS & MongoDB connections cleanly
    d. process.exit(0)
```

Without the `preStop` sleep, Kubernetes removes the pod from Ingress and sends `SIGTERM` simultaneously. Ingress takes 2–3 seconds to update its routing table, so incoming requests during those 2–3 seconds hit a terminating container and return 502!

---

## 4. How It Applies to Our Services

```text
infra/k8s/
├── orders-mongo-depl.yaml     ──► Converted to StatefulSet + PVC + rs0 init
├── tickets-mongo-depl.yaml    ──► Converted to StatefulSet + PVC + rs0 init
├── payments-mongo-depl.yaml   ──► Converted to StatefulSet + PVC + rs0 init
├── auth-mongo-depl.yaml       ──► Converted to StatefulSet + PVC + rs0 init
├── expiration-redis-depl.yaml ──► Converted to StatefulSet + PVC + AOF
└── *-depl.yaml (App Pods)     ──► Add readiness/liveness probes, preStop, & resource limits
```

In `@mehul-mrtickets/common`:
* Add reusable `healthRouter` exposing `/healthz/live` and `/healthz/ready`.
* Add reusable `registerGracefulShutdown(server, connections)`.

---

## 5. Alternatives Considered

* **Managed Databases (Atlas / AWS RDS):** Ideal in cloud production, but not self-contained for local offline development.
* **3-Node Mongo Cluster locally:** Exceeds typical developer laptop RAM budgets.
* **1-Node StatefulSet with replica set (Chosen):** The industry standard pattern for local Kubernetes testing of transaction-capable databases.

---

## 6. What Will Change (Preview)

1. **Common Package:** Bump version with `healthRouter` and shutdown helpers.
2. **Kubernetes Manifests:** Replace DB deployments with StatefulSets; add probes and resource limits to all app deployments.
3. **App Services (`index.ts`):** Mount health routes, implement graceful shutdown, and fail-fast if DB fails to connect on startup.

---

## 7. Glossary

* **StatefulSet:** A Kubernetes controller for stateful applications requiring persistent identity and storage.
* **Headless Service:** A Kubernetes service with `clusterIP: None` that allows direct DNS resolution of individual pods.
* **PVC (PersistentVolumeClaim):** An abstraction representing a durable disk storage allocation.
* **AOF (Append-Only File):** A persistence engine for Redis logging every write command.
* **Readiness Probe:** Kubernetes check determining if a pod should receive customer traffic.
* **Liveness Probe:** Kubernetes check determining if a container should be restarted.
* **Connection Draining:** Allowing in-flight requests to complete before closing server sockets.

---

## 8. Self-Check Questions

<details>
<summary><b>1. Why can't we run MongoDB multi-document transactions on a standalone instance?</b></summary>
MongoDB transactions require the replication oplog to coordinate multi-document atomic operations and rollbacks. The oplog is only created and active when MongoDB runs as a Replica Set.
</details>

<details>
<summary><b>2. What is the difference between a Deployment and a StatefulSet?</b></summary>
Deployments treat pods as identical and disposable with random names and ephemeral storage. StatefulSets provide deterministic pod names (e.g. <code>orders-mongo-0</code>), stable DNS names, and retain the exact same persistent disk (PVC) across restarts.
</details>

<details>
<summary><b>3. Why must a Liveness probe NEVER check external dependencies like MongoDB?</b></summary>
If MongoDB slows down or experiences a temporary network blip, every microservice checking it in its liveness probe will report unhealthy. Kubernetes will reboot all service pods simultaneously, amplifying the outage into a full cluster cascade failure.
</details>

<details>
<summary><b>4. Why is a <code>preStop: sleep 5</code> hook necessary before the SIGTERM handler?</b></summary>
When a pod is deleted, Kubernetes informs the Ingress controller and kube-proxy to stop routing traffic to that pod. That routing table update takes 2–3 seconds to propagate. The <code>sleep 5</code> keeps the container alive long enough to prevent Ingress from sending traffic to a dead socket.
</details>

<details>
<summary><b>5. How does Redis AOF persistence protect the expiration service?</b></summary>
Redis AOF writes every delayed job and lock to disk continuously. If the Redis pod restarts, it reloads all in-flight expiration jobs from disk, preventing tickets from becoming permanently stuck in locked orders.
</details>
