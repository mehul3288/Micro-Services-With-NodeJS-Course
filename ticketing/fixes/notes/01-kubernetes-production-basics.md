# Production Notes: Kubernetes Infrastructure & Resilience

> **Phase 01 Reference Manual:** Core distributed infrastructure patterns, storage lifecycles, health probe contracts, and graceful shutdown mechanics.

---

## 1. Core Architecture Analogies

### Analogy 1: Why MongoDB Needs a Replica Set for Transactions (The "Undo Ledger")
* **The Standalone Trap:** When MongoDB runs as a single, standalone instance, it executes write commands in-place without maintaining an operation log (`local.oplog.rs`).
* **The Analogy:** Think of an accountant working on paper spreadsheets. 
  - Without an **Undo Ledger**, as soon as the accountant writes in row 5, the ink is on the paper. If step 6 fails, the accountant cannot safely "roll back" all changes across multiple documents because there is no historical record of what the spreadsheet looked like 2 milliseconds ago.
  - The **Oplog** is that chronological, immutable Undo Ledger. Every multi-document ACID transaction writes tentative changes while recording their exact undo steps. If any step fails or times out, the engine replays the undo steps in reverse.
  - **Key Takeaway:** MongoDB disables multi-document ACID transactions and change streams on standalone nodes because the oplog does not exist. Even on a single node in local development, running with `--replSet rs0` forces MongoDB to activate the oplog, enabling ACID transactions.

---

### Analogy 2: Liveness vs Readiness (The "Office Filing Cabinet Death Spiral")
* **The Trap:** Developers often write a `/health` endpoint that pings MongoDB and Redis, and point **both** the Kubernetes Liveness and Readiness probes at it.
* **The Analogy:**
  - Imagine you are a clerk processing loan files at your desk. The **filing cabinet (MongoDB)** across the room gets jammed for 30 seconds.
  - **Readiness Probe:** Asks, *"Can you process a new customer file right now?"* You say, *"No, the cabinet is jammed, wait a moment."* The receptionist stops sending new customers to your desk. You sit calmly at your desk waiting for the lock to clear. This is correct.
  - **Liveness Probe:** Asks, *"Is the clerk alive and conscious?"*
  - **The Death Spiral:** If your boss fires you and replaces you with a new clerk every time the cabinet jams, the new clerk sits down, boots their computer, looks at the jammed cabinet, and gets fired 10 seconds later! Meanwhile, every clerk in the office gets fired simultaneously. The office descends into chaos, and when the cabinet finally unjams, nobody is working.
* **The Golden Rule:**
  - **Liveness probe (`/healthz/live`):** Only checks if the Node.js event loop is responding. Never check external dependencies. If it fails, Kubernetes kills and restarts the container.
  - **Readiness probe (`/healthz/ready`):** Checks if connections (MongoDB, NATS, Redis) are open and the service is ready to accept traffic. If it fails, Kubernetes temporarily detaches the pod from Service routing. **No restarts.**

---

## 2. StatefulSet vs Deployment

| Feature | Deployment | StatefulSet |
|---|---|---|
| **Pod Naming** | Random hash suffix (`orders-depl-78c6f-x9z2p`) | Predictable ordinal index (`orders-mongo-0`) |
| **Network Identity** | Dynamic IP behind ClusterIP load balancer | Stable FQDN via Headless Service (`orders-mongo-0.orders-mongo-srv`) |
| **Storage Binding** | Pods share a PVC or mount ephemeral disks | Each ordinal pod gets its own dedicated PVC template |
| **Restart Behavior** | New pod may start on different node with clean disk | Recreated pod re-attaches to the exact same persistent disk volume |
| **Scaling Order** | Parallel, random shutdown | Strict descending ordinal shutdown (`2 → 1 → 0`) |

### Why Headless Services (`clusterIP: None`)?
A standard Kubernetes Service assigns a virtual ClusterIP that round-robins traffic across matching pods. 
A **Headless Service** tells Kubernetes: *"Do not assign a virtual IP. Instead, return the direct A-records for each individual pod."*
CoreDNS generates:
```text
<pod-name>.<service-name>.<namespace>.svc.cluster.local
```
This enables the MongoDB replica set members and drivers to directly address individual nodes (`orders-mongo-0.orders-mongo-srv`).

> [!IMPORTANT]
> **Headless Service Gotcha:** Set `publishNotReadyAddresses: true` on the headless service for StatefulSet databases. Otherwise, CoreDNS will refuse to publish the pod's DNS record until the pod is marked "Ready", preventing database clustering scripts (like `rs.initiate()`) from resolving their own hostnames during startup.

---

## 3. Redis Persistence: AOF vs RDB

| Persistence Mode | How it Works | Data Loss Window | Performance Impact |
|---|---|---|---|
| **RDB (Snapshots)** | Forks child process every $N$ minutes and dumps point-in-time memory image to disk (`dump.rdb`) | Up to 5–15 minutes of data | Low CPU overhead during normal ops; high fork latency on large memory |
| **AOF (`appendonly yes`)** | Logs every single write command sequentially to an append-only log file | Configurable via `appendfsync` | Constant minor I/O write stream |

### The `appendfsync everysec` Trade-off
- `appendfsync always`: Flushes to physical disk after every write. Highest durability, but destroys throughput on SSDs/HDDs.
- `appendfsync no`: Delegates flushing to OS buffer cache (up to 30s delay).
- `appendfsync everysec` (Gold Standard): Background thread flushes the AOF buffer to disk once every second. At most ~1 second of jobs can be lost on a catastrophic host crash.

---

## 4. Graceful Shutdown & The Propagation Window

### The Problem: Why `server.close()` Alone Drops Traffic
When you trigger a rollout (`kubectl rollout restart`), Kubernetes executes two actions in parallel:
1. Sends `SIGTERM` to the container process.
2. Removes the pod's IP from the Service endpoints list in `kube-proxy` and ingress controllers.

**The Network Race:** Updating iptables / IPVS rules across all Kubernetes nodes takes between **1 to 3 seconds**. If your Node.js process immediately closes its HTTP server upon receiving `SIGTERM`, incoming requests that were already in-flight from ingress hit a closed port, resulting in `502 Bad Gateway` or `ECONNRESET`.

### The Production Solution: `preStop` Sleep + Phased Teardown
```text
1. Kubernetes initiates pod termination
   │
   ├─► Ingress / kube-proxy begins detaching pod IP from load balancer endpoints
   │
   └─► preStop hook executes: sleep 5
         (Gives the cluster 5 seconds to finish propagating endpoint removal)
         
2. SIGTERM signal sent to Node.js process
   │
   ├─► Mark shutdownState.isShuttingDown = true  (Ready probe starts returning 503)
   │
   ├─► server.close()  (Stops accepting NEW connections, finishes IN-FLIGHT requests)
   │
   ├─► Close message broker / NATS streaming connection
   │
   ├─► Disconnect database (mongoose.disconnect())
   │
   └─► process.exit(0)
```

---

## 5. Staff-Level Interview Questions & Answers

### Q1: Why should you never check your database in a Liveness probe?
> **Answer:** Checking a downstream dependency in a liveness probe conflates process health with dependency availability. If the database experiences a momentary connection spike or failover, every microservice pod's liveness check will fail simultaneously. Kubernetes will then kill and restart every container. When all pods reboot at once, they bombard the recovering database with simultaneous connection attempts (the "thundering herd" problem), turning a minor transient blip into a catastrophic cascading outage. Liveness probes must only verify that the local process event loop is alive.

### Q2: How does Kubernetes handle a persistent volume when a StatefulSet pod crashes?
> **Answer:** In a StatefulSet, PVCs are decoupled from the pod lifecycle. When `orders-mongo-0` crashes, the PVC (`orders-mongo-storage-orders-mongo-0`) remains bound to the physical storage volume. When Kubernetes reschedules `orders-mongo-0`, the StatefulSet controller deterministically re-attaches that exact same PVC to the new pod instance, ensuring zero data loss across pod restarts.

### Q3: What is the purpose of `publishNotReadyAddresses: true` in a StatefulSet headless service?
> **Answer:** By default, Kubernetes headless services only return DNS records for pods in the `Ready` state. When bootstrapping a clustered system like a MongoDB replica set, the pod cannot become Ready until the replica set is initiated, but `rs.initiate()` requires resolving the member's hostname. Setting `publishNotReadyAddresses: true` forces CoreDNS to publish the pod's DNS record immediately upon container creation, breaking the circular dependency.
