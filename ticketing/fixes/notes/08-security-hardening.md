# Phase 08 Architecture Notes: Security Hardening & Zero-Trust

## Executive Summary
Phase 08 elevates the ticketing platform from perimeter-only security into defense-in-depth:
1. **OAuth 2.0 Security BCP Session Management:** Replaced forever-valid stateless JWTs with 15-minute access JWTs coupled to 7-day rotating refresh tokens with SHA-256 at-rest hashing and automatic theft/reuse family tree invalidation.
2. **GitOps-Compliant Secret Sealing:** Eliminated plaintext base64 Kubernetes secrets from version control using Bitnami Sealed Secrets asymmetric cryptography.
3. **Zero-Trust Network Architecture:** Deployed Linkerd Service Mesh providing transparent pod-to-pod mutual TLS (mTLS) with 24-hour rotating X.509 certificates and strict `Server` + `AuthorizationPolicy` database isolation preventing lateral cluster movement.

---

## 1. Identity & Session Security: Token Rotation Design

### Threat Model Addressed
- **Perpetual Session Hijacking:** In the legacy design, JWTs were signed without expiration (`expiresIn`). An attacker stealing a cookie retained access forever.
- **Signout Bypass:** In the legacy design, signing out only cleared the client's cookie; the signed JWT remained mathematically valid across all services.
- **Database Compromise:** If an attacker breached the database read-only, plaintext tokens would yield full access.

### Solution Architecture
- **Dual-Token Model:**
  - **Access Token:** 15-minute lifetime, signed JWT with payload `{ id, email }`. Verified statelessly by all downstream services using `JWT_KEY`.
  - **Refresh Token:** 7-day lifetime, cryptographically random 40-byte hex string. Stored exclusively as an irreversible SHA-256 hash in MongoDB (`refresh_tokens` collection) with a native MongoDB TTL index on `expiresAt`.
- **Dedicated Cookie Scoping:**
  - Refresh token cookie is set with `HttpOnly: true`, `SameSite: strict`, and crucially **`Path: /api/users/refresh`**.
  - The browser **only** transmits the refresh token when communicating directly with `/api/users/refresh`, shielding it from every other business route (`/api/tickets`, `/api/orders`, `/api/payments`).
- **Family Tree Tracking & Theft Reuse Detection (OAuth 2.0 BCP):**
  - Every login assigns a new `familyId`.
  - During token rotation, the current token is marked `revokedAt = Date.now()` and linked via `replacedBy` to the new token.
  - **Attacker Replay:** If an attacker presents a token whose `revokedAt != null`, the system detects immediate theft and **atomically revokes every token sharing that `familyId`**, instantaneously locking out both the attacker and alerting the user.

---

## 2. GitOps Secret Management: Sealed Secrets

### Threat Model Addressed
- Standard Kubernetes `Secret` manifests store payloads in Base64 (`YXNkZg==`), which is merely encoding, not encryption.
- Committing raw `Secret` manifests to Git leaks database credentials, Stripe keys, and JWT secrets to all repository readers.

### Solution Architecture
- **Bitnami Sealed Secrets Controller** runs in `kube-system` holding an in-cluster private key.
- The controller publishes an unsealed public certificate (`kubeseal --fetch-cert`).
- Developers use `kubeseal` to seal raw secrets locally into `SealedSecret` custom resources.
- The encrypted ciphertext is committed to `infra/k8s/secrets/sealed-secrets.yaml` and deployed via GitOps/Skaffold.
- The in-cluster controller unseals the ciphertext in memory into native `jwt-secret` and `stripe-secret` resources for our pods.

---

## 3. Zero-Trust Linkerd Service Mesh & Database Isolation

### Threat Model Addressed
- In a vanilla Kubernetes cluster, pod-to-pod networking is unencrypted plain TCP. Any compromised workload (e.g. an unpatched npm package in `payments`) could connect directly to `auth-mongo` or `orders-mongo` on port 27017 and dump all database tables.

### Solution Architecture
- **Linkerd Rust Micro-Proxy:** Injected as a sidecar into all application and database pods via `linkerd.io/inject: enabled`.
- **Automatic mTLS:** All TCP connections between pods are encrypted with TLS 1.3 using short-lived X.509 identity certificates issued by the Linkerd trust anchor.
- **Cryptographic Workload Identity:**
  - Each microservice and its database are assigned a dedicated `ServiceAccount` (`auth-sa`, `tickets-sa`, `orders-sa`, `payments-sa`, `expiration-sa`, `client-sa`).
- **Authorization Policies & Server Isolation:**
  - Databases are annotated with `config.linkerd.io/default-inbound-policy: "deny"`.
  - Linkerd `Server` on port 27017 accepts connections **only** if the inbound client presents a verified `MeshTLSAuthentication` matching its dedicated `ServiceAccount`.
---

## 4. Cold-Boot Cluster Resilience & Dependency Ordering

### Problem
- On fresh computer restart or cluster cold boot, `skaffold dev` deploys all 18 manifests simultaneously.
- Stateful components like Kafka take ~15–20 seconds to initialize storage volumes and KRaft quorum.
- Monitoring components like `kafka-exporter` start in ~1–2 seconds and do not have built-in retry logic; failing to contact brokers immediately caused exit code 255.
- Skaffold's deployment status check detected container failure and initiated full cleanup/rollback.

### Solution
- **True Broker Readiness InitContainer:** Added `wait-for-kafka` initContainer to `infra/k8s/observability/kafka-exporter.yaml` using `apache/kafka:3.9.0` executing `/opt/kafka/bin/kafka-broker-api-versions.sh --bootstrap-server kafka-0.kafka-srv:9092`.
- **Sidecar Isolation:** Applied `linkerd.io/inject: "disabled"` to `kafka-exporter-depl` to prevent sidecar init iptables interception.
- **Headless Service DNS:** Configured `publishNotReadyAddresses: true` on `kafka-srv` so DNS resolutions succeed during cold boot.
- **Microservice Probe Alignment:** Moved Express health listener prior to blocking listener subscriptions in `expiration/src/index.ts` so liveness probes pass immediately.
