# Phase 08 — Security Hardening (Refresh Tokens, Sealed Secrets, mTLS)

**Goal:** Limit the damage of a stolen token, stop keeping secrets in plain text, and make sure services only talk to the
services they are supposed to talk to, over encrypted connections.

**Grouped because:** the three cover **identity** (users), **secrets** (config) and **service-to-service trust**
(network). Together they make up a complete "security posture" story.

---

## 1. Problems

| # | Problem | Where | Impact |
|---|---|---|---|
| 1 | JWT has **no expiry** | [auth/src/routes/signin.ts](../auth/src/routes/signin.ts) line 22 (`jwt.sign` without `expiresIn`) | A stolen cookie works **forever** |
| 2 | Signout only clears the cookie on the client | `auth/src/routes/signout.ts` | The token stays valid if someone copied it |
| 3 | Secrets created by hand with `kubectl create secret` | `jwt-secret`, `stripe-secret` | Not versioned, not reproducible, and you can't commit them |
| 4 | Pod-to-pod traffic is plain HTTP / TCP | whole cluster | Anyone inside the cluster can sniff or call any service and **any database** |

---

## 2. Access + Refresh Tokens with Rotation

### Design
| Token | Lifetime | Stored where | Sent to |
|---|---|---|---|
| **Access JWT** | 15 min | `session.jwt` cookie (exactly as today) | every service, verified statelessly |
| **Refresh token** | 7 days | Separate `refresh` cookie: httpOnly, secure, `sameSite=strict`, **`path=/api/users/refresh`** | **only** the auth refresh endpoint |

Other services change **nothing**: `jwt.verify` in [common current-user.ts](../common/src/middlewares/current-user.ts)
already rejects expired tokens. Revocation works through the short access lifetime + refusing to refresh.

### Storage — `auth/src/models/refresh-token.ts`
| Field | Notes |
|---|---|
| `userId` | owner |
| `tokenHash` | **SHA-256** of the token. The raw token is never stored, so a DB leak doesn't leak sessions |
| `familyId` | all tokens descended from one login |
| `expiresAt` | TTL index removes expired rows automatically |
| `revokedAt`, `replacedBy` | rotation bookkeeping |

Stored in the auth Mongo DB (durable, already exists) rather than Redis (would be a new dependency).

### Rotation and reuse detection
```text
 login        → issue R1 (family F)
 refresh(R1)  → R1 revoked, replacedBy R2 → issue R2 + new access JWT
 refresh(R2)  → R2 revoked → issue R3
 ── attacker replays the stolen R1 ──
 refresh(R1)  → R1 is ALREADY revoked → REUSE DETECTED
              → revoke the whole family F (R3 too) → both attacker and user must log in again
```
This is the OAuth 2.0 Security BCP approach. A stolen refresh token can be used **at most once** before it's detected.

### Endpoints (auth service)
| Route | File | Behavior |
|---|---|---|
| `POST /api/users/signin` / `signup` | existing | + issue refresh token, `expiresIn: "15m"` on the JWT |
| `POST /api/users/refresh` | NEW `routes/refresh.ts` | rotate as above, set new cookies |
| `POST /api/users/signout` | existing | + revoke the family, clear both cookies |

Token creation and rotation logic lives in `auth/src/services/token-service.ts`, next to the existing `services/password.ts`.

### Client
- [client/hooks/use-request.js](../client/hooks/use-request.js): on **401**, call `/api/users/refresh` once, then retry the request.
  If the refresh fails → redirect to signin.
- Server components: `currentuser` returns `null` once the access token expires. A small Next.js `middleware.js`
  refreshes proactively when the access cookie is close to expiry.
- Test setup: `global.signin()` keeps working as-is (it creates a valid, unexpired JWT).

---

## 3. Sealed Secrets

### Why
Kubernetes `Secret`s are only base64-encoded, so you can't commit them. Sealed Secrets encrypts them with the cluster's
public key: the **encrypted** version is safe to commit, and only the in-cluster controller can decrypt it.

```text
 plain Secret (never committed) ──kubeseal──► SealedSecret (committed in infra/k8s/secrets/)
                                                     │ applied by skaffold
                                                     ▼
                                    sealed-secrets controller ──► real Secret in cluster
```

### Steps
```powershell
# one-time
kubectl apply -f https://github.com/bitnami-labs/sealed-secrets/releases/download/<version>/controller.yaml
# per secret
kubectl create secret generic jwt-secret --from-literal=JWT_KEY=... --dry-run=client -o yaml `
  | kubeseal --format yaml > infra/k8s/secrets/jwt-sealed-secret.yaml
```
Same for `stripe-secret`. Deployments are **unchanged**: they still reference `jwt-secret` / `stripe-secret`.

> **Back up the controller's private key** (`kubectl get secret -n kube-system -l sealedsecrets.bitnami.com/sealed-secrets-key -o yaml`).
> Losing it means every sealed secret has to be re-created.

### Alternatives (for the interview)
| Option | When |
|---|---|
| Sealed Secrets (chosen) | GitOps-friendly, zero external dependencies, works locally |
| External Secrets Operator + AWS Secrets Manager / GCP Secret Manager | Real cloud deployments, central rotation |
| HashiCorp Vault | Dynamic secrets (short-lived DB credentials), large organizations |

---

## 4. Service Mesh — Linkerd (mTLS + Authorization Policies)

### Why Linkerd over Istio
Linkerd is much lighter (Rust micro-proxy), installs in minutes, and has **mTLS on by default** with zero config.
Istio has more features, but its resource use and complexity are too much for a local cluster.

### Step 1: mTLS everywhere
```powershell
linkerd install --crds | kubectl apply -f -
linkerd install | kubectl apply -f -
linkerd check
linkerd viz install | kubectl apply -f -
```
Add `linkerd.io/inject: enabled` to every pod template (services, databases, Kafka, Redis).
From then on, all pod-to-pod traffic is encrypted and authenticated with per-workload certificates that rotate automatically.

Mongo (27017) and Kafka (9092) are marked as opaque ports (`config.linkerd.io/opaque-ports`), because they are not HTTP
and the proxy must not try to detect a protocol.

### Step 2: zero-trust authorization (the part that actually shows security thinking)
mTLS gives every workload a cryptographic identity (its ServiceAccount). We then allow **only** the expected callers:

| Server (target) | Allowed clients |
|---|---|
| `orders-mongo` | `orders` only |
| `tickets-mongo` | `tickets` only |
| `payments-mongo` | `payments` only |
| `auth-mongo` | `auth` only |
| `kafka` | all 5 Node services |
| each Node service `:3000` | Kong gateway, client (SSR), Prometheus |

Implemented with Linkerd `Server` + `AuthorizationPolicy` + `MeshTLSAuthentication` resources in `infra/k8s/mesh/`.
Each service gets its own `ServiceAccount` (needed for identity).

Result: even if the payments pod is compromised, it **cannot connect to the auth database**.

> Kubernetes `NetworkPolicy` would do something similar at L3/L4, but Docker Desktop's default CNI doesn't enforce it.
> Linkerd policies work regardless, and they are identity-based instead of IP-based.

---

## 5. Tests

| Test | Where |
|---|---|
| Signin sets both cookies; the access JWT has `exp` ≈ 15 min | `auth/src/routes/__test__/signin.test.ts` |
| Refresh rotates: old token revoked, new one works | `auth/src/routes/__test__/refresh.test.ts` |
| Reusing a revoked token revokes the whole family | same |
| Signout revokes the family | `signout.test.ts` |
| Only the hash is stored | `refresh-token` model test |
| Expired access JWT → `currentUser` null → 401 on protected routes | `common` |

---

## 6. Verification

| Check | Expected |
|---|---|
| Wait 15 min (or set `ACCESS_TOKEN_TTL=1m`) → use the app | Transparent refresh, no logout |
| Copy the refresh cookie, refresh normally, then replay the old cookie with curl | 401 + user logged out everywhere |
| `git grep STRIPE_KEY` / inspect `infra/k8s/secrets/` | Only encrypted values in the repo |
| `linkerd viz edges deployment` | All edges show 🔒 secured |
| `kubectl exec` into payments → try to connect to `auth-mongo-srv:27017` | **Connection refused by policy** |
| Re-run `purchase-flow.js` with the mesh on | Record the added latency (p95 overhead of sidecars) |

Record in `results/phase-08-security.md`.

---

## 7. Interview Angle

- **Stateless JWT revocation problem**, and the short-access + refresh-rotation answer.
- **Refresh token reuse detection** and why tokens are hashed at rest.
- **Cookie flags**: httpOnly, secure, sameSite, and `path` scoping of the refresh cookie.
- **Secrets in GitOps**: Sealed Secrets vs External Secrets vs Vault.
- **Zero trust**: identity-based authorization, not "inside the network = trusted".
- **mTLS**: what it adds over TLS (client authentication), and who issues and rotates certificates (the Linkerd identity service).
- **Mesh trade-offs**: latency and resource overhead vs security and observability gains (with measured numbers).

---

## 8. Checklist

- [ ] Concept lesson written in `fixes/lessons/08-auth-security-and-zero-trust.md`, taught & discussed in detail, and explicit go-ahead signal received from developer
- [ ] Auth: 15-min JWT, `RefreshToken` model, `token-service.ts`, `/refresh` route, signout revocation
- [ ] Client: refresh-on-401 in `use-request`, Next.js middleware
- [ ] Sealed Secrets controller + sealed `jwt-secret` and `stripe-secret` committed
- [ ] Linkerd installed, all workloads injected, opaque ports set
- [ ] ServiceAccounts + Linkerd authorization policies (DB isolation)
- [ ] Tests + verification complete, results recorded
- [ ] `notes/08-security.md` written
