# Phase 01 — Infrastructure Foundation

**Goal:** Data that survives pod restarts, pods that Kubernetes can health-check, and services that
shut down without dropping requests.

**Grouped because:** all four items are about how pods behave in Kubernetes (storage, probes, lifecycle),
and Phase 04 transactions need the replica set to exist first.

---

## 1. Problems in the Current Code

| # | Problem | Where | Impact |
|---|---|---|---|
| 1 | Mongo runs as a `Deployment` with no volume | [orders-mongo-depl.yaml](../infra/k8s/orders-mongo-depl.yaml) (same for all 4 DBs) | Pod restart = **all data gone** |
| 2 | Mongo is standalone, not a replica set | same | Multi-document **transactions are impossible** (needed in Phase 04) |
| 3 | Redis has no persistence | [expiration-redis-depl.yaml](../infra/k8s/expiration-redis-depl.yaml) | Redis restart = **delayed expiry jobs lost** → tickets locked forever |
| 4 | No liveness / readiness probes | all `*-depl.yaml` | Traffic is sent to pods that aren't connected to Mongo/NATS yet |
| 5 | SIGTERM closes NATS → `process.exit()` immediately | [orders/src/index.ts](../orders/src/index.ts) lines 30–37 | In-flight HTTP requests are **dropped on every deploy** |
| 6 | Startup errors are caught and the server starts anyway | [orders/src/index.ts](../orders/src/index.ts) lines 43–48 | A pod with no DB connection reports healthy and serves 500s |
| 7 | No CPU / memory requests or limits | all `*-depl.yaml` | One noisy pod can starve the node; scheduler can't plan |

---

## 2. Mongo → StatefulSet + Replica Set + PVC

### Design
```text
                ┌───────────────────────────────────────────┐
                │ StatefulSet: orders-mongo  (replicas: 1)  │
                │                                           │
                │  Pod: orders-mongo-0                      │
                │   mongod --replSet rs0 --bind_ip_all      │
                │   volume: /data/db ◄── PVC (1Gi)          │
                └───────────────────────────────────────────┘
                                   ▲
       Headless Service: orders-mongo-srv  (clusterIP: None)
       Stable DNS: orders-mongo-0.orders-mongo-srv
```

- **StatefulSet** gives a stable pod name (`orders-mongo-0`) and keeps the same volume across restarts.
- **Headless service** gives each pod a stable DNS name, which the replica set config needs.
- **Single-member replica set**: enough for transactions and change streams, and cheap locally.
  Phase 10 scales one DB to 3 members to show automatic failover.

### Replica set initialization
`rs.initiate()` has to run once, after `mongod` starts. We use a `postStart` lifecycle hook with a retry loop:
it is idempotent (does nothing if already initiated) and keeps the setup in the same YAML file.

```yaml
lifecycle:
  postStart:
    exec:
      command:
        - sh
        - -c
        - |
          until mongosh --quiet --eval "db.adminCommand('ping')"; do sleep 1; done
          mongosh --quiet --eval "try { rs.status() } catch (e) { rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'orders-mongo-0.orders-mongo-srv:27017' }] }) }"
```

### Files
| File | Change |
|---|---|
| `infra/k8s/auth-mongo-depl.yaml` → rename to `auth-mongo-statefulset.yaml` | StatefulSet + headless service + `volumeClaimTemplates` |
| same for `tickets`, `orders`, `payments` | same |
| `infra/k8s/*-depl.yaml` (services) | `MONGO_URI` → `mongodb://orders-mongo-0.orders-mongo-srv:27017/orders?replicaSet=rs0` |

---

## 3. Redis Persistence

`expiration-redis` becomes a StatefulSet with a PVC and AOF enabled:

```yaml
args: ["redis-server", "--appendonly", "yes", "--appendfsync", "everysec"]
```

`appendfsync everysec` means at most ~1 second of jobs can be lost on a crash. Phase 05 adds a
**sweeper** in the orders service as a safety net for that last second.

---

## 4. Health Checks

### Two endpoints, two meanings
| Endpoint | Question it answers | Checks | On failure Kubernetes... |
|---|---|---|---|
| `GET /healthz/live` | "Is the process stuck?" | Nothing external, just responds | **restarts** the pod |
| `GET /healthz/ready` | "Can I serve traffic right now?" | Mongo `readyState === 1`, broker connected, not shutting down | **removes** the pod from the Service (no restart) |

Liveness must **not** check Mongo. Otherwise a short DB outage makes Kubernetes restart every pod at once,
and the outage becomes a cascading failure.

### Code
New file in common, `common/src/middlewares/health-router.ts`:

```ts
import express, { Request, Response } from "express";

type ReadinessCheck = () => boolean;

export const healthRouter = (readinessChecks: ReadinessCheck[]) => {
    const router = express.Router();

    router.get("/healthz/live", (req: Request, res: Response) => {
        res.send({ status: "ok" });
    });

    router.get("/healthz/ready", (req: Request, res: Response) => {
        const isReady = readinessChecks.every((check) => check());
        res.status(isReady ? 200 : 503).send({ status: isReady ? "ready" : "not-ready" });
    });

    return router;
};
```

Used in each service's `app.ts`, **before** `currentUser`:
```ts
app.use(healthRouter([
    () => mongoose.connection.readyState === 1,
    () => natsWrapper.isConnected,
    () => !shutdownState.isShuttingDown
]));
```

The **expiration** service has no HTTP server today. It gets a minimal `app.ts` with only the health router.

### Kubernetes probes (added to each service Deployment)
```yaml
readinessProbe:
  httpGet: { path: /healthz/ready, port: 3000 }
  periodSeconds: 5
  failureThreshold: 2
livenessProbe:
  httpGet: { path: /healthz/live, port: 3000 }
  initialDelaySeconds: 10
  periodSeconds: 10
  failureThreshold: 3
```

---

## 5. Graceful Shutdown

### Shutdown sequence
```text
SIGTERM received
   │
   ├─1─► mark "shutting down"  → /healthz/ready returns 503
   ├─2─► preStop hook already slept 5s → Service endpoints updated, no new traffic arrives
   ├─3─► server.close()        → stop accepting connections, let in-flight requests finish
   ├─4─► close broker client   → stop consuming new events
   ├─5─► mongoose.disconnect()
   └─6─► process.exit(0)

   Safety net: if all of this takes > 20s → process.exit(1)
   (terminationGracePeriodSeconds is 30s, so Kubernetes never needs to SIGKILL)
```

### Code
New file in common, `common/src/shutdown.ts`, so the same sequence is used by all services:

```ts
import { Server } from "http";

type Closer = () => Promise<void>;

export const shutdownState = { isShuttingDown: false };

export const registerGracefulShutdown = (server: Server, closers: Closer[]) => {
    const shutdown = async () => {
        if (shutdownState.isShuttingDown) return;
        shutdownState.isShuttingDown = true;

        // Hard limit so a stuck connection can never block the pod from terminating
        setTimeout(() => process.exit(1), 20 * 1000).unref();

        server.close();
        for (const close of closers) {
            await close();
        }
        process.exit(0);
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
};
```

### Changes to every service `index.ts`
- Startup errors → `console.error(e); process.exit(1);` so Kubernetes restarts the pod instead of serving 500s.
- `app.listen(...)` moves **inside** the `try`, after all connections succeed.
- Replace the `natsWrapper.client.on("close", process.exit)` and the SIGINT/SIGTERM lines with `registerGracefulShutdown(...)`.
- `natsWrapper` gets an `isConnected` getter for the readiness check.

### Kubernetes changes
```yaml
terminationGracePeriodSeconds: 30
lifecycle:
  preStop:
    exec:
      command: ["sleep", "5"]
```

---

## 6. Resource Requests & Limits

Added to every container. Starting values (tuned later with Phase 06 metrics):

| Workload | requests (cpu / mem) | limits (cpu / mem) |
|---|---|---|
| Node services | 100m / 128Mi | 500m / 256Mi |
| Mongo | 100m / 256Mi | 500m / 512Mi |
| Redis | 50m / 64Mi | 200m / 128Mi |

---

## 7. Verification

| Test | How | Expected |
|---|---|---|
| Data survives restart | Create tickets → `kubectl delete pod tickets-mongo-0` → `GET /api/tickets` | All tickets still there |
| Replica set active | `kubectl exec orders-mongo-0 -- mongosh --eval "rs.status().ok"` | `1` |
| Redis jobs survive restart | Create order → delete `expiration-redis-0` → wait for expiry | Order still gets cancelled |
| Zero-downtime rollout | Run `purchase-flow.js` → `kubectl rollout restart deployment orders-depl` | **0 failed requests** (compare with Phase 00) |
| Readiness | Scale orders-mongo to 0 | Orders pod becomes NotReady but is **not** restarted |
| Unit tests | `healthRouter` returns 503 when a check fails | pass |

Record the numbers in `results/phase-01-infrastructure.md`.

---

## 8. Interview Angle

- **Deployment vs StatefulSet**: stable identity + stable storage. Why databases need it.
- **Liveness vs readiness**, and why liveness must not depend on downstream systems (cascading restarts).
- **Graceful shutdown ordering**, and why the `preStop` sleep is needed (endpoint propagation delay).
- **Why a replica set even with 1 member**: the oplog is what makes transactions and change streams possible.
- **AOF vs RDB** persistence in Redis, and the trade-off of `everysec`.

---

## 9. Checklist

- [ ] Concept lesson written in `fixes/lessons/01-infrastructure-foundation.md`, taught & discussed in detail, and explicit go-ahead signal received from developer
- [ ] 4 Mongo StatefulSets with PVC + replica set init
- [ ] All `MONGO_URI` values updated with `?replicaSet=rs0`
- [ ] Redis StatefulSet with AOF + PVC
- [ ] `healthRouter` + `registerGracefulShutdown` added to common, version published
- [ ] All services: health router, graceful shutdown, fail-fast startup
- [ ] Expiration service: minimal health server
- [ ] Probes, preStop, resources on every Deployment
- [ ] Verification table complete, results recorded
- [ ] `notes/01-kubernetes-production-basics.md` written
