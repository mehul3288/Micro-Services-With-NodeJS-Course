# Phase 08: Security Hardening (Refresh Tokens, Sealed Secrets & Zero-Trust mTLS)

> **Phase Goal:**
> Transform the platform from an open, trust-everything perimeter into a hardened, defense-in-depth architecture.
> We address the three fundamental pillars of modern enterprise security:
> 1. **Identity & Session Security:** Short-lived access JWTs + Family-based Refresh Token Rotation with automatic theft/reuse detection (OAuth 2.0 Security BCP).
> 2. **Config & Secret Integrity:** GitOps-friendly encrypted secrets via Sealed Secrets (zero plaintext secrets in Git).
> 3. **Network & Service-to-Service Trust:** Zero-Trust mutual TLS (mTLS) and identity-based authorization policies (strict database and service isolation).

---

## 1. Threat Modeling: What Attacks Are We Vulnerable To Today?

```text
 ┌────────────────────────────────────────────────────────────────────────────────────────┐
 │ CURRENT THREAT VECTOR MAP (Phase 00 - Phase 07)                                       │
 ├─────────────────────────┬───────────────────────────────────┬──────────────────────────┤
 │ Attack Surface          │ Current Architecture Vulnerability│ Business & Security Risk │
 ├─────────────────────────┼───────────────────────────────────┼──────────────────────────┤
 │ 1. Stolen Session Cookie│ JWT signed with NO `expiresIn`.   │ Attacker has FOREVER     │
 │    or Network Intercept │ Token valid indefinitely.         │ access to user account.  │
 ├─────────────────────────┼───────────────────────────────────┼──────────────────────────┤
 │ 2. Signout Bypass       │ `signout` only deletes client-side│ Cloned / exported token  │
 │                         │ cookie; token is never revoked.   │ continues to work.       │
 ├─────────────────────────┼───────────────────────────────────┼──────────────────────────┤
 │ 3. Stored Token DB Leak │ Plaintext tokens stored in DB.    │ Read-only DB breach leaks│
 │                         │                                   │ all active sessions.     │
 ├─────────────────────────┼───────────────────────────────────┼──────────────────────────┤
 │ 4. Plaintext Git Secrets│ `jwt-secret` / `stripe-secret`    │ Accidental repo exposure │
 │                         │ base64 only, manually created.    │ exposes production keys. │
 ├─────────────────────────┼───────────────────────────────────┼──────────────────────────┤
 │ 5. Lateral Movement &   │ Flat K8s cluster network. Pods    │ Compromised pod can dump │
 │    Database Sniffing    │ connect to any DB via plain TCP.  │ any database in cluster. │
 └─────────────────────────┴───────────────────────────────────┴──────────────────────────┘
```

---

## 2. Pillar 1: Identity & Session Security (Access + Refresh Token Rotation)

### 2.1 The Stateless JWT Revocation Dilemma
Stateless JWTs are popular because downstream microservices (`tickets`, `orders`, `payments`) verify signatures locally using the shared `JWT_KEY` without making a network call to the `auth` database.

**The Trap:**
If you sign a JWT without expiration (or a long expiration like 30 days):
- You cannot revoke it without invalidating the `JWT_KEY` for *all* users across the entire system.
- If an attacker intercepts the token via XSS, network proxy, or client malware, they possess permanent access.
- When the user clicks "Sign Out", the server can only tell the browser to clear its cookie; the cryptographic signature on the token remains mathematically valid.

### 2.2 The Industry Standard Solution: Access + Refresh Token Rotation
We split identity into two tokens with strictly separated responsibilities:

| Characteristic | Access Token (JWT) | Refresh Token (Opaque String) |
| :--- | :--- | :--- |
| **Format** | Cryptographically signed JWT | Opaque cryptographically random hex string (`crypto.randomBytes(32)`) |
| **Lifetime** | **15 minutes** (short-lived) | **7 days** (long-lived) |
| **Storage (Client)** | `session.jwt` cookie | Dedicated `refresh` cookie: `HttpOnly`, `Secure`, `SameSite=Strict`, **`Path=/api/users/refresh`** |
| **Storage (Database)**| Stateless (Nowhere in database) | **Hashed (SHA-256)** in Auth MongoDB `refresh_tokens` collection |
| **Audience** | Verified statelessly by all microservices | Processed **only** by Auth service at `/api/users/refresh` |

### 2.3 Refresh Token Rotation & Family-Based Reuse Detection
To prevent a stolen refresh token from being used forever, we implement **Automatic Rotation** on every refresh request, combined with **Family Tree Tracking** as specified by the **OAuth 2.0 Security Best Current Practice (BCP)**.

#### The Happy Path: Normal Token Rotation
```text
1. User logs in (signin / signup)
   └── Auth generates:
       - Access JWT (15 min)
       - Refresh Token R1 belonging to Family F1
       - Saves SHA-256(R1) in DB (status: active, familyId: F1)
       - Returns both cookies to client

2. 14 minutes later, client calls POST /api/users/refresh with R1
   └── Auth verifies R1:
       - Computes SHA-256(R1) and queries DB
       - Validates R1 is active and not expired
       - Atomically marks R1 as REVOKED (replacedBy: R2)
       - Issues brand new Access JWT + new Refresh Token R2 (familyId: F1)
       - Returns new cookies to client
```

#### The Attack Scenario: Automatic Reuse Detection
What happens if an attacker intercepted `R1` before the legitimate user refreshed?

```text
  Legitimate User                       Attacker
        │                                  │
        │── Uses R1 to refresh ──►         │
        │  Auth marks R1 revoked,          │
        │  issues R2 to User               │
        │                                  │
        │                          ── Replays stolen R1 ──►
        │                                  │
        │                                  ▼
        │                     Auth checks DB for SHA-256(R1):
        │                     - Token R1 status: "REVOKED"!
        │                     - REUSE DETECTED!
        │                                  ▼
        │                     CRITICAL SECURITY ACTION:
        │                     Revoke ALL tokens with familyId: F1!
        │                     (Both R2 and any future tokens wiped)
        │                                  ▼
        │◄── Next request fails 401        │◄── Request rejected 401
   (User forced to re-authenticate)   (Attacker completely locked out)
```

> [!IMPORTANT]
> **Why SHA-256 Hash at Rest?**
> If an attacker gains read access to the MongoDB `refresh_tokens` collection via SQL/NoSQL injection, they find only SHA-256 hashes (`tokenHash`). Because SHA-256 is an irreversible one-way cryptographic hash, the attacker **cannot** use the database contents to authenticate as any user!

---

## 3. Pillar 2: GitOps Secret Management (Sealed Secrets)

### 3.1 The Kubernetes Secret Obfuscation Fallacy
When developers write a normal Kubernetes `Secret` manifest:
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: jwt-secret
data:
  JWT_KEY: YXNkZg== # echo "YXNkZg==" | base64 -d  ==> "asdf"
```
Many mistakenly believe: *"Hey, the file says `kind: Secret`, so our passwords and API keys are protected!"*

**It is NOT protected at all.**
- `YXNkZg==` is simply the word `asdf` written in **Base64**.
- Base64 is **not encryption** — it is just an encoding scheme (like writing English in Morse code). Anyone with a terminal or browser can decode it in 1 millisecond.
- **The GitOps Dilemma:** In modern DevOps, best practice states that every Kubernetes manifest should be stored in Git (GitHub/GitLab) so CI/CD or Skaffold can deploy it automatically. But if you commit a standard Kubernetes `Secret` to Git, anyone with access to your repository (developers, contractors, or attackers if a repo leaks) immediately gains full access to your production JWT keys, Stripe secrets, and database passwords.

---

### 3.2 The Solution: Sealed Secrets (The "Open Padlock" Analogy)

To solve this, Bitnami created **Sealed Secrets**. The easiest way to understand Sealed Secrets is the **Open Padlock Analogy**:

1. **The Bank Vault (Your Kubernetes Cluster):**
   - Inside your Kubernetes cluster, a special controller (`sealed-secrets-controller`) generates a **Private Key** and a **Public Key**.
   - The **Private Key** never leaves the cluster. It stays locked inside the cluster's memory.
   - The cluster hands out the **Public Key** to the world. Think of this public key as an **Open Padlock**.

2. **The Developer Locks the Box:**
   - On your local laptop, you take your sensitive secret (`JWT_KEY=asdf`).
   - You put it in a metal box and snap the cluster's open padlock shut using a CLI tool called `kubeseal`.
   - Once that padlock snaps shut, **NOBODY** in the world can open it — not you, not your teammates, not even a hacker who steals your laptop. Only the owner of the Private Key (the in-cluster controller) can unlock it.

3. **Safe in Git:**
   - This permanently locked box is called a **`SealedSecret`** (an encrypted custom Kubernetes resource).
   - Because it cannot be decrypted without the private key inside the cluster, **it is 100% safe to commit `SealedSecret` YAML files directly into public or private Git repositories**.

4. **Automatic In-Cluster Decryption:**
   - When Skaffold or `kubectl apply` sends the `SealedSecret` to Kubernetes, the `sealed-secrets-controller` recognizes its own padlock, uses its private key to unlock it, and automatically generates an unencrypted standard Kubernetes `Secret` in-memory for your pods to consume.

### 3.3 Sealed Secrets Flow Diagram

```text
 DEVELOPER WORKSTATION                             KUBERNETES CLUSTER
 ┌──────────────────────┐                         ┌──────────────────────────────────────┐
 │ Raw Secret           │                         │ sealed-secrets-controller            │
 │ (JWT_KEY / STRIPE_KEY│                         │ (namespace: kube-system)             │
 └──────────┬───────────┘                         └──────────────────┬───────────────────┘
            │                                                        │
            ▼                                                        │ Generates Keypair
   `kubeseal` CLI ◄────── Fetches Cluster Public Key (Padlock) ──────┘
            │
            ▼
 ┌──────────────────────┐                         ┌──────────────────────────────────────┐
 │ SealedSecret CRD     │   kubectl apply / Git   │ Controller decrypts with             │
 │ (Locked Box / Cipher)├────────────────────────►│ In-Cluster Private Key               │
 └──────────────────────┘                         └──────────────────┬───────────────────┘
   (Safe to commit to Git)                                           │
                                                                     ▼
                                                  ┌──────────────────────────────────────┐
                                                  │ Real Kubernetes Secret (In-Memory)   │
                                                  │ jwt-secret / stripe-secret           │
                                                  └──────────────────────────────────────┘
```

---

## 4. Pillar 3: Zero-Trust Network Architecture & Service-to-Service mTLS

### 4.1 The "Castle and Moat" Illusion
Most traditional architectures treat microservices security like a medieval castle:
- You put a big gate with guards at the entrance (**Kong API Gateway**).
- You inspect users entering the front gate.
- **The fatal flaw:** Once you are *inside* the castle walls, **every single door is wide open and everyone trusts everyone.**

```text
               KONG GATEWAY (The Castle Gate)
                             │
            ┌────────────────┴────────────────┐
            ▼                                 ▼
       payments-srv                       auth-mongo
 (Suppose a hacker exploits              (Stores user
 an unpatched npm package in             passwords & emails)
 payments and gets a shell!)                   ▲
            │                                 │
            └───────── PLAIN TCP ─────────────┘
              "Hey auth-mongo, give me all passwords!"
              auth-mongo: "Sure! You're inside the network,
              so I trust you!"
```

In a vanilla Kubernetes cluster:
1. **Pod-to-pod traffic is unencrypted plain text:** Anyone running inside the cluster can eavesdrop on network traffic (sniffing tokens, database queries, and credit cards).
2. **There is no identity check between pods:** Any pod can call *any* database or *any* other pod on the cluster network.

---

### 4.2 The Solution: Linkerd Service Mesh (The Personal Bodyguard Analogy)

A **Service Mesh** throws away the idea of a "trusted inside network." It assumes **Zero Trust** (*"Never trust, always verify"*).

Imagine every single Pod is assigned its own **personal security bodyguard** (a tiny, high-speed proxy written in Rust that sits as a sidecar right next to your container):

```text
 ┌─────────────────────────┐                     ┌─────────────────────────┐
 │       AUTH POD          │                     │       PAYMENTS POD      │
 │  ┌───────────────────┐  │                     │  ┌───────────────────┐  │
 │  │ Node.js Container │  │                     │  │ Node.js Container │  │
 │  └─────────┬─────────┘  │                     │  └─────────┬─────────┘  │
 │            │            │                     │            │            │
 │            ▼            │                     │            ▼            │
 │  ┌───────────────────┐  │   Encrypted mTLS    │  ┌───────────────────┐  │
 │  │ Linkerd Bodyguard │◄─┼─────────────────────┼─►│ Linkerd Bodyguard │  │
 │  │   (Rust Proxy)    │  │   Tunnel (X.509)    │  │   (Rust Proxy)    │  │
 │  └───────────────────┘  │                     │  └───────────────────┘  │
 └─────────────────────────┘                     └─────────────────────────┘
```

The bodyguards perform three essential tasks:

#### 1. Automatic Mutual TLS (mTLS) — "The Encrypted Walkie-Talkie"
Whenever Pod A talks to Pod B:
- Their bodyguards secretly establish an encrypted tunnel between them.
- Even if an attacker taps into the Kubernetes network, all they see is scrambled binary noise.
- Certificates automatically rotate every 24 hours with zero manual intervention.

#### 2. Cryptographic Workload Identity (`ServiceAccount` ID Badges)
Every microservice is assigned its own Kubernetes `ServiceAccount`:
- `auth-sa`, `tickets-sa`, `orders-sa`, `payments-sa`, `expiration-sa`.
- The Linkerd bodyguard automatically attaches an official cryptographic ID badge (X.509 certificate) identifying which `ServiceAccount` is speaking.

#### 3. Authorization Policies — "Checking the Guest List"
We give each database and sensitive service a strict guest list using Linkerd `Server` and `AuthorizationPolicy` custom resources:
- **`auth-mongo`'s bodyguard rule:**  
  *"Only let someone in if their ID badge says `ServiceAccount: auth-sa`. If anyone else knocks, slam the door shut."*
- **`orders-mongo`'s bodyguard rule:**  
  *"Only let someone in if their ID badge says `ServiceAccount: orders-sa`."*

Now, if a hacker compromises the `payments` pod and tries to query `auth-mongo`:
```text
 payments-pod ──► Knocks on auth-mongo ──► Bodyguard checks badge:
                                          "You are payments-sa! 
                                           You are NOT on my guest list!"
                                          ──► CONNECTION DENIED! (403 / Dropped)
```
The hacker is trapped in the `payments` pod and cannot move laterally to steal user passwords from `auth-mongo`!

---

### 4.3 Why Linkerd over Istio?

In system design and engineering interviews, this is a frequent question:

| Feature | Istio | Linkerd (Our Choice) |
| :--- | :--- | :--- |
| **Technology** | Heavy C++ (Envoy Proxy) | Ultra-lightweight Rust micro-proxy |
| **Memory / CPU Footprint** | Heavy (~500MB - 1GB RAM) | Lightweight (~30MB RAM per proxy) |
| **Configuration** | Complex, dozens of overlapping CRDs | **mTLS on by default** with zero configuration |
| **Local Cluster Fit** | Slows down Docker Desktop | Fast, unobtrusive, runs effortlessly locally |

---

### 4.4 Architecture Diagram: Database & Workload Isolation

```text
 ┌─────────────────┐       mTLS (auth-sa)        ┌─────────────────┐
 │ auth-srv Pod    ├────────────────────────────►│ auth-mongo      │  ===> ALLOWED (200)
 └─────────────────┘                             └─────────────────┘
                                                           ▲
 ┌─────────────────┐   mTLS (payments-sa)                 │
 │ payments-srv Pod├──────────────────────────────────────┘           ===> REJECTED BY POLICY!
 └─────────────────┘                                                       (Connection Denied)
```

---

## 5. Implementation Roadmap for Phase 08

1. **Step 1: Auth Service Hardening (Access + Refresh Token Rotation):**
   - Create `auth/src/models/refresh-token.ts` (with TTL index, SHA-256 hash, family ID).
   - Create `auth/src/services/token-service.ts` (token generation, hashing, rotation, reuse detection).
   - Update `auth/src/routes/signin.ts` & `signup.ts` (15m JWT + secure refresh cookie).
   - Implement `auth/src/routes/refresh.ts` (`POST /api/users/refresh`).
   - Update `auth/src/routes/signout.ts` (revoke token family).
   - Write comprehensive unit & integration tests (`refresh.test.ts`, `signin.test.ts`).

2. **Step 2: Client-Side Silent Refresh:**
   - Update `client/hooks/use-request.js` with automatic 401 retry interceptor.
   - Add Next.js proactive token refreshing.

3. **Step 3: GitOps Secret Management (Sealed Secrets):**
   - Install Sealed Secrets controller in Kubernetes cluster.
   - Seal `jwt-secret` and `stripe-secret` into `infra/k8s/secrets/`.

4. **Step 4: Zero-Trust Service Mesh & Policies (Linkerd mTLS):**
   - Install Linkerd CRDs & control plane.
   - Annotate deployments with `linkerd.io/inject: enabled`.
   - Define Linkerd `Server` and `AuthorizationPolicy` manifests isolating databases and internal endpoints.

5. **Step 5: Verification & Benchmarking:**
   - Test refresh token reuse replay attack (confirm family revocation).
   - Test cross-service database access denial.
   - Measure sidecar latency impact under load.
