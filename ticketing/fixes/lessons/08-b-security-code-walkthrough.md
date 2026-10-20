# Phase 08 Code Walkthrough: Security Hardening & Zero-Trust Architecture

This document provides a line-by-line and file-by-file code walkthrough of all modifications introduced in Phase 08.

---

## 1. Auth Service: Token Model & Service

### File: `auth/src/models/refresh-token.ts`
- **Schema Fields:**
  - `userId`: Identifier linking the token to the owning user.
  - `tokenHash`: Irreversible SHA-256 hash of the 40-byte random refresh token. Plaintext tokens are never stored in the database.
  - `familyId`: UUID identifying the lineage/family tree of tokens originating from a single signin/signup event.
  - `expiresAt`: Date timestamp 7 days in the future.
  - `revokedAt`: Null when active; set to a Date timestamp when rotated or invalidated.
  - `replacedBy`: SHA-256 hash of the successor token in the family tree.
- **Indexes:**
  - `tokenHash: 1` (unique): Guarantees fast lookup and prevents collisions.
  - `familyId: 1`: Enables atomic invalidation of an entire token family upon reuse detection.
  - `expiresAt: 1` (`expireAfterSeconds: 0`): MongoDB TTL index automatically purges expired tokens without background cron jobs.

### File: `auth/src/services/token-service.ts`
- **`hashToken(rawToken)`:** Uses Node.js `crypto.createHash('sha256')` to compute the hex digest.
- **`generateAccessToken(user)`:** Signs a 15-minute JWT (`{ id: user.id, email: user.email }`) using `process.env.JWT_KEY!`.
- **`createRefreshToken(userId, existingFamilyId)`:** Generates 40 random bytes, creates an unrevoked document in `RefreshToken`, and returns `{ rawToken, familyId, expiresAt }`.
- **`rotateRefreshToken(rawRefreshToken)`:**
  1. Hashes incoming token and queries MongoDB.
  2. If missing, throws `NotAuthorizedError`.
  3. **Theft Reuse Detection:** If `tokenDoc.revokedAt != null`, it triggers atomic family revocation (`RefreshToken.updateMany({ familyId, revokedAt: null }, { revokedAt: new Date() })`) and throws `NotAuthorizedError`.
  4. If expired, throws `NotAuthorizedError`.
  5. On success: Marks old token revoked (`tokenDoc.revokedAt = new Date()`), creates successor token in same `familyId`, sets `tokenDoc.replacedBy`, and returns fresh 15m access token + new refresh token.
- **`extractRefreshToken(req)`:** Checks `req.body.refreshToken` first (convenient for API clients/mobile/curl), then parses `req.headers.cookie` for `refreshToken=...`.

---

## 2. Auth Routes

### File: `auth/src/routes/refresh.ts`
- **`POST /api/users/refresh`**:
  - Extracts the refresh token from cookie or body.
  - Executes `TokenService.rotateRefreshToken(rawToken)`.
  - Sets updated 15m JWT into session cookie: `req.session = { jwt: accessToken }`.
  - Sets rotated refresh token into dedicated cookie:
    ```typescript
    res.cookie("refreshToken", newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV !== "test",
      sameSite: "strict",
      path: "/api/users/refresh",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    ```
  - Responds with HTTP 200 `{ id, email, refreshToken }`.

### Files: `auth/src/routes/signin.ts` & `signup.ts`
- Generate short-lived access JWT via `TokenService.generateAccessToken()`.
- Generate 7-day refresh token via `TokenService.createRefreshToken()`.
- Return both session cookie and path-restricted `refreshToken` cookie.

### File: `auth/src/routes/signout.ts`
- Extracts incoming refresh token and invokes `TokenService.revokeByRawToken(rawToken)` to invalidate the token family in MongoDB.
- Clears `req.session = null`.
- Clears the refresh token cookie: `res.clearCookie("refreshToken", { path: "/api/users/refresh" })`.

---

## 3. Client Silent Refresh Interceptor

### File: `client/api/api-client.js`
- Implements an Axios response interceptor that transparently captures HTTP 401 errors.
- **Deduplication:** Uses a shared `refreshPromise` so multiple parallel requests that fail simultaneously wait on a single `/api/users/refresh` call rather than racing.
- On refresh success, retries the original failed request with `axios(originalRequest)`.
- On refresh failure (e.g. session expired or family revoked), rejects the promise and prompts re-authentication.

---

## 4. GitOps Secret Management (Bitnami Sealed Secrets)

### 4.1 Under-the-Hood Architecture: How It Works
Traditional Kubernetes `Secret` manifests store secrets encoded in **Base64** (`echo "asdf" | base64` $\rightarrow$ `YXNkZg==`). Base64 is merely an encoding scheme for safe binary transport, **not encryption**. If committed to Git, anyone with repository read access (engineers, contractors, automated CI tools, or compromised GitHub tokens) can immediately read production credentials.

```text
DEVELOPER MACHINE (Client-Side)                     KUBERNETES CLUSTER (Server-Side)
┌───────────────────────────────┐                  ┌─────────────────────────────────────────┐
│ Plaintext Secret              │                  │ sealed-secrets-controller               │
│ (JWT_KEY, STRIPE_KEY, DB_PASS)│                  │ (runs in namespace: kube-system)        │
└──────────────┬────────────────┘                  └──────────────────┬──────────────────────┘
               │                                                      │
               ▼                                                      │ Keypair Generation (RSA-4096)
         `kubeseal` CLI ◄────── Fetches Cluster Public Key (Cert) ────┘
               │
               ▼ (Asymmetric RSA Encryption)
┌───────────────────────────────┐
│ SealedSecret Manifest (CRD)   │ ─── Git Commit / Pull Request / CI/CD ───┐
│ (Encrypted Ciphertext Block)  │                                          │
└───────────────────────────────┘                                          │
                                                                           ▼
                                                   ┌─────────────────────────────────────────┐
                                                   │ SealedSecret Controller watches K8s API │
                                                   │ Decrypts using in-cluster Private Key   │
                                                   └──────────────────┬──────────────────────┘
                                                                      │ (Reconciliation Loop)
                                                                      ▼
                                                   ┌─────────────────────────────────────────┐
                                                   │ Unsealed Native Kubernetes Secret       │
                                                   │ (kind: Secret in memory/etcd)           │
                                                   └─────────────────────────────────────────┘
```

1. **Asymmetric RSA Cryptography:**
   - The controller generates an **RSA-4096** keypair on initial cluster boot.
   - The **Private Key** is held in a protected Kubernetes secret in `kube-system` and *never* leaves the cluster boundary.
   - The **Public Certificate** is publicly accessible to any developer or CI runner.
2. **Client-Side One-Way Sealing:**
   - The developer encrypts the plaintext secret using the public certificate via the `kubeseal` CLI tool.
   - Once encrypted, **the data cannot be decrypted by the developer, other developers, or an attacker who steals the Git repository**. Only the in-cluster controller holding the private key can unseal it.
3. **Reconciliation & Scope:**
   - The `SealedSecret` custom resource definition (CRD) contains metadata (name, namespace) cryptographically bound into the ciphertext payload. This prevents "secret transplant attacks" (an attacker copying an encrypted database secret into another namespace to read it).
   - The controller's control loop decrypts the `SealedSecret` and writes an unsealed standard `kind: Secret` into the target namespace for pods to reference via `secretKeyRef`.

---

### 4.2 How to Create a New Sealed Secret (Copy-Paste Reference)

#### Method 1: The One-Liner (Most Common for Single Keys)
To seal a key directly without writing any unencrypted files to disk:

**Linux / macOS / Git Bash:**
```bash
kubectl create secret generic jwt-secret \
  --from-literal=JWT_KEY=my-super-secret-key \
  --dry-run=client -o yaml | \
  kubeseal --format=yaml \
    --controller-name=sealed-secrets-controller \
    --controller-namespace=kube-system > infra/k8s/secrets/jwt-sealed-secret.yaml
```

**Windows PowerShell:**
```powershell
kubectl create secret generic jwt-secret `
  --from-literal=JWT_KEY=my-super-secret-key `
  --dry-run=client -o yaml | `
  .\kubeseal.exe --format=yaml `
    --controller-name=sealed-secrets-controller `
    --controller-namespace=kube-system | `
  Out-File -Encoding utf8 infra/k8s/secrets/jwt-sealed-secret.yaml
```

#### Method 2: Sealing from a `.env` File or Multiple Secrets
If you have multiple keys (e.g., Stripe keys, API tokens, webhook secrets):
```bash
# 1. Create secret from .env file in dry-run mode
kubectl create secret generic stripe-secret \
  --from-literal=STRIPE_KEY=sk_test_12345 \
  --from-literal=STRIPE_WEBHOOK_SECRET=whsec_abcde \
  --dry-run=client -o yaml | \
  kubeseal --format=yaml \
    --controller-name=sealed-secrets-controller \
    --controller-namespace=kube-system > infra/k8s/secrets/stripe-sealed-secret.yaml
```

#### Method 3: Offline Sealing for CI/CD Pipelines (No Direct Cluster Access Needed)
In enterprise CI/CD environments, developers or build agents might not have direct network access to the Kubernetes API server. You can fetch the public certificate once and seal completely offline:
```bash
# Step 1: Export public certificate once and save to repository
kubeseal --fetch-cert \
  --controller-name=sealed-secrets-controller \
  --controller-namespace=kube-system > pub-sealed-secrets.pem

# Step 2: Developers and CI pipelines seal offline using only the public cert
kubectl create secret generic payment-secrets \
  --from-literal=API_KEY=secret-123 \
  --dry-run=client -o yaml | \
  kubeseal --cert pub-sealed-secrets.pem --format=yaml > infra/k8s/secrets/payment-sealed.yaml
```

---

### 4.3 How to Explain Sealed Secrets in an Interview (4.5 Years Senior Pitch)
> *"In our microservices deployment, we follow strict GitOps principles where all infrastructure manifests are version-controlled and deployed declaratively via Skaffold and CI/CD. However, standard Kubernetes Secret manifests store data in Base64 encoding, which presents a critical credential leakage risk if committed to GitHub.*
> 
> *To solve this without needing external enterprise vaults like HashiCorp Vault or AWS Secrets Manager for our local and mid-tier environments, I integrated **Bitnami Sealed Secrets**. It uses asymmetric RSA-4096 cryptography: the controller generates a keypair inside the cluster and publishes an unsealed public certificate. On our workstations or CI pipelines, we use the `kubeseal` CLI to encrypt secrets into `SealedSecret` custom resources. These files are 100% safe to commit to Git and review in PRs. Once applied to the cluster, the in-cluster controller uses its private key to dynamically reconcile and generate standard Kubernetes Secrets in memory for downstream pods.*
> 
> *Additionally, we enforce strict namespace scoping on sealed secrets to prevent cross-namespace replay attacks, aligning our platform with enterprise SOC 2 and PCI-DSS compliance standards."*

---

## 5. Zero-Trust Linkerd Service Mesh & Database Isolation

### 5.1 Under-the-Hood Architecture: How Linkerd Works
Vanilla Kubernetes uses a flat, unsegmented overlay network (e.g., flannel, calico, or Docker bridge). Every pod can open a TCP socket to any other pod on the cluster IP network. If an attacker exploits an unpatched npm package or remote code execution (RCE) in a public-facing service (like `payments`), they can laterally traverse the cluster and query MongoDB instances directly on port 27017.

Linkerd eliminates this vulnerability by enforcing a **Zero-Trust Network Architecture** (*"Never trust, always verify"*):

```text
┌─────────────────────────────────────────┐               ┌─────────────────────────────────────────┐
│               AUTH POD                  │               │             AUTH-MONGO POD              │
│ ┌─────────────────────────────────────┐ │               │ ┌─────────────────────────────────────┐ │
│ │ Node.js Container (auth)            │ │               │ │ MongoDB Engine (mongod :27017)      │ │
│ └──────────────────┬──────────────────┘ │               │ └──────────────────▲──────────────────┘ │
│                    │ localhost:3000     │               │                    │ localhost:27017    │
│                    ▼                    │               │                    │                    │
│ ┌─────────────────────────────────────┐ │               │ ┌──────────────────┴──────────────────┐ │
│ │ Linkerd Sidecar Proxy (Rust)        │ │  mTLS (TLS1.3)│ │ Linkerd Sidecar Proxy (Rust)        │ │
│ │ - Injected iptables packet rewrite  ├─┼───────────────┼─► - Checks Server Policy              │ │
│ │ - Cryptographic ID: auth-sa         │ │ (Encrypted)   │ │ - Checks MeshTLSAuthentication      │ │
│ └─────────────────────────────────────┘ │               │ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘               └─────────────────────────────────────────┘
                                                                               ▲
                                                                               │ mTLS (TLS 1.3)
                                                                               │ Client ID: payments-sa
                                                           ┌───────────────────┴─────────────────────┐
                                                           │ Linkerd Policy Engine Check:            │
                                                           │ - Target: auth-mongo-27017              │
                                                           │ - Required ID: auth-sa                  │
                                                           │ - Presented ID: payments-sa             │
                                                           │ ──► POLICY VIOLATION!                   │
                                                           │ ──► Immediate TCP Reset / Socket Close  │
                                                           └─────────────────────────────────────────┘
```

#### How the Components Function:
1. **The `linkerd-init` Container & iptables Redirection:**
   - When a pod starts, Linkerd runs a brief init container (`linkerd-init`) that configures Linux `iptables` rules inside the pod's network namespace.
   - It intercepts all inbound and outbound TCP traffic and invisibly redirects it to the Linkerd proxy on port 4143 (inbound) and port 4140 (outbound). The Node.js application code requires zero code changes.
2. **The Rust Micro-Proxy:**
   - Linkerd does not use Envoy (C++). It uses a custom-built, memory-safe proxy written in **Rust**.
   - It consumes only **~30MB of RAM** and adds less than **1ms** of p99 latency, making it ideal for high-throughput microservices.
3. **Automatic Mutual TLS (mTLS):**
   - The `linkerd-identity` controller acts as an in-cluster Certificate Authority (CA).
   - It issues short-lived **X.509 certificates** to each proxy based on the pod's Kubernetes `ServiceAccount`.
   - Certificates automatically rotate every **24 hours** in-memory without restarting pods.
4. **Declarative Authorization Policies (Layer 4 Isolation):**
   - **`Server` CRD:** Declares that port 27017 on `auth-mongo` is a managed endpoint with `proxyProtocol: opaque` (bypassing HTTP protocol detection for raw database wire protocols).
   - **`MeshTLSAuthentication` CRD:** Defines the allowed identity:
     `auth-sa.default.serviceaccount.identity.linkerd.cluster.local`.
   - **`AuthorizationPolicy` CRD:** Enforces that connections to `Server/auth-mongo-27017` are accepted **only** if the client presents verified cryptographic credentials matching `auth-sa`.
   - **`default-inbound-policy: "deny"`:** Any client that is not explicitly whitelisted (like `payments-sa` or unauthenticated pods) has its connection dropped at the network boundary before reaching MongoDB.

---

### 5.2 Why Linkerd over Istio? (Trade-off Analysis for Interviews)

| Evaluation Criteria | Istio (Envoy-based) | Linkerd (Rust-based) | Architectural Decision |
| :--- | :--- | :--- | :--- |
| **Data Plane Technology** | Envoy Proxy (C++) | Linkerd2-Proxy (Rust) | Rust eliminates memory corruption bugs (buffer overflows) and garbage collection pauses. |
| **Resource Overhead** | Heavy: ~500MB to 1GB+ RAM per proxy | **Lightweight: ~30MB RAM** per proxy | Linkerd runs efficiently in local Docker Desktop clusters and drastically reduces cloud EC2/node costs. |
| **Operational Complexity** | High: Dozens of overlapping CRDs (VirtualService, DestinationRule, EnvoyFilter) | **Low: Zero-config mTLS** by default, intuitive `Server` and `AuthorizationPolicy` CRDs | Faster developer onboarding, fewer misconfiguration incidents. |
| **Local Cluster Impact** | Causes CPU throttling and slow test cycles on local machines | Unobtrusive, fast startup, negligible local CPU footprint | Ideal for pair programming, local Skaffold inner loops, and enterprise production alike. |

---

### 5.3 How to Explain Linkerd & Zero-Trust in an Interview (4.5 Years Senior Pitch)
> *"In our distributed microservices platform, we eliminated the traditional 'castle-and-moat' security illusion where everything inside the internal cluster network is implicitly trusted. In a standard Kubernetes cluster, any compromised service can move laterally across the flat network and execute unauthorized queries against any database.*
> 
> *To enforce true Zero-Trust, I implemented **Linkerd Service Mesh** across our services. We chose Linkerd over Istio because its ultra-lightweight Rust micro-proxy consumes only ~30MB of RAM per pod compared to Istio's heavy Envoy footprint, while providing transparent mutual TLS (mTLS) by default.*
> 
> *Here is how our implementation protects the platform:*
> 1. *Every microservice deployment and MongoDB StatefulSet is bound to its own dedicated Kubernetes `ServiceAccount` (`auth-sa`, `tickets-sa`, `orders-sa`, etc.).*
> 2. *Linkerd's identity controller issues short-lived, cryptographic X.509 certificates to each proxy, establishing verified workload identities that rotate automatically every 24 hours.*
> 3. *We enforce strict Layer 4 database isolation policies using Linkerd's `Server` and `AuthorizationPolicy` CRDs, with `default-inbound-policy` set to `deny`.*
> 
> *As a concrete example: `auth-mongo` accepts connections exclusively from clients presenting the `auth-sa` mTLS identity. If an attacker exploits an npm vulnerability in the `payments` service and attempts to access `auth-mongo`, the Linkerd sidecar inspects the TLS client identity (`payments-sa`), detects that it is unauthorized, and immediately terminates the TCP socket at the network boundary. This guarantees strict blast-radius containment across all microservices."*

