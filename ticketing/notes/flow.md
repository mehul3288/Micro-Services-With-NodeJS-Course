# End-to-End Request Flow: Browser to Auth Service in Kubernetes

This document details exactly how an HTTP/HTTPS request travels from your web browser, through Kubernetes networking and Ingress-Nginx, down to your Express.js route handlers in the `auth` service.

---

## 1. High-Level Architectural Flow Diagram

```text
┌──────────────────────────────────────────────────────────────────────────────────┐
│                             1. CLIENT MACHINE                                    │
│                                                                                  │
│   🌐 Web Browser / Postman                                                       │
│   Request: https://ticketing.dev/api/users/currentuser                           │
│         │                                                                        │
│         ▼ (Step 1: Check DNS)                                                    │
│   📄 Local Hosts File (C:\Windows\System32\drivers\etc\hosts)                   │
│   Config: "127.0.0.1 ticketing.dev"                                              │
└─────────┬────────────────────────────────────────────────────────────────────────┘
          │
          │ (Step 2: TCP Request to 127.0.0.1 on Port 80 / 443)
          ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                         2. LOCAL HOST / DOCKER LAYER                             │
│                                                                                  │
│   🔌 Host Ports (80 / 443)                                                       │
│   Forwarded by Docker Desktop / Minikube directly into Kubernetes                │
└─────────┬────────────────────────────────────────────────────────────────────────┘
          │
          │ (Step 3: Traffic enters cluster)
          ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                         3. KUBERNETES CLUSTER                                    │
│                                                                                  │
│  ┌────────────────────────────────────────────────────────────────────────────┐  │
│  │ 🌐 INGRESS LAYER (Namespace: ingress-nginx)                                │  │
│  │                                                                            │  │
│  │   📦 Ingress-Nginx Controller Pod (Running active NGINX process)           │  │
│  │   Reads Ingress Rules from: infra/k8s/ingress-srv.yaml                    │  │
│  │                                                                            │  │
│  │   Match Rule:                                                              │  │
│  │     • Host: ticketing.dev                                                  │  │
│  │     • Path: /api/users/?(.*)                                               │  │
│  │     • Target Backend: auth-srv:3000                                        │  │
│  └──────────────────────────────────┬─────────────────────────────────────────┘  │
│                                     │                                            │
│                                     │ (Step 4: Resolve Backend Pod IP)           │
│                                     ▼                                            │
│  ┌────────────────────────────────────────────────────────────────────────────┐  │
│  │ 🛡️ SERVICE DISCOVERY & ENDPOINTS                                           │  │
│  │                                                                            │  │
│  │   ClusterIP Service: auth-srv (infra/k8s/auth-depl.yaml)                  │  │
│  │   Selector: app=auth  ──►  Endpoints List: [ 10.244.0.18:3000 ]            │  │
│  └──────────────────────────────────┬─────────────────────────────────────────┘  │
│                                     │                                            │
│                                     │ (Step 5: Direct HTTP to Pod IP)            │
│                                     ▼                                            │
│  ┌────────────────────────────────────────────────────────────────────────────┐  │
│  │ 📦 AUTH POD (Namespace: default | Label: app=auth | IP: 10.244.0.18)       │  │
│  │                                                                            │  │
│  │   ┌────────────────────────────────────────────────────────────────────┐   │  │
│  │   │ 🚀 Node.js / Express Application (Port: 3000)                      │   │  │
│  │   │                                                                    │   │  │
│  │   │  [1] app.set('trust proxy', true)                                  │   │  │
│  │   │       └─► Trusts X-Forwarded-Proto header from Ingress             │   │  │
│  │   │  [2] app.use(json())                                               │   │  │
│  │   │       └─► Parses JSON body                                         │   │  │
│  │   │  [3] app.use(cookieSession({ secure: true }))                      │   │  │
│  │   │       └─► Decodes Cookie / Session payload                         │   │  │
│  │   │  [4] currentUserRouter                                             │   │  │
│  │   │       └─► GET /api/users/currentuser                               │   │  │
│  │   │            └─► currentUser middleware (JWT verification)           │   │  │
│  │   │            └─► Route Handler: res.send({ currentUser: ... })       │   │  │
│  │   │                                                                    │   │  │
│  │   │  [5] MongoDB Connection: mongodb://auth-mongo-srv:27017/auth       │   │  │
│  │   └────────────────────────────────────────────────────────────────────┘   │  │
│  └──────────────────────────────────┬─────────────────────────────────────────┘  │
└─────────────────────────────────────┼────────────────────────────────────────────┘
                                      │
                                      │ (Step 6: HTTP 200 OK JSON Response)
                                      ▼
                        [ Browser receives response ]
```

---

## 2. Detailed Step-by-Step Walkthrough

---

### Step 1: DNS Resolution & Host Machine Mapping

```text
┌──────────────────────────────────────────────────┐
│ User enters URL in Browser:                      │
│ https://ticketing.dev/api/users/currentuser      │
└────────────────────────┬─────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────┐
│ OS checks Local Hosts File:                      │
│ C:\Windows\System32\drivers\etc\hosts            │
│ Line: "127.0.0.1 ticketing.dev"                  │
└────────────────────────┬─────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────┐
│ Host Resolved to Loopback IP:                    │
│ 127.0.0.1                                        │
│ Send TCP handshake to 127.0.0.1:443 (HTTPS)      │
└──────────────────────────────────────────────────┘
```

#### What happens:
1. When you enter `https://ticketing.dev/api/users/currentuser`, your browser must first translate `ticketing.dev` into an IP address.
2. The operating system checks the local `hosts` file before querying public DNS servers.
3. It finds the entry `127.0.0.1 ticketing.dev` and directs traffic to your local loopback address (`127.0.0.1`) on port `443` (for HTTPS) or port `80` (for HTTP).

#### 📁 Configuration Associated:
- **Location:** `C:\Windows\System32\drivers\etc\hosts` (Windows) or `/etc/hosts` (Mac/Linux)
- **Line:**
  ```text
  127.0.0.1 ticketing.dev
  ```

#### 🔍 Hidden Detail:
Kubernetes clusters running inside Docker Desktop / Minikube expose port 80 and 443 to your host machine. Without this `hosts` file entry, your browser would attempt to find a real domain named `ticketing.dev` on the internet and fail with `NXDOMAIN` or `DNS_PROBE_FINISHED_NXDOMAIN`.

---

### Step 2: Traffic Ingestion by the Ingress-Nginx Controller

```text
┌───────────────────────────────────────────────────────┐
│ TCP Packet arrives at Host Port 80 / 443              │
└──────────────────────────┬────────────────────────────┘
                           │
                           ▼
┌───────────────────────────────────────────────────────┐
│ Docker Desktop / Minikube Port Forwarding             │
│ Routes packet into the Kubernetes Node                │
└──────────────────────────┬────────────────────────────┘
                           │
                           ▼
┌───────────────────────────────────────────────────────┐
│ Ingress-Nginx Controller Pod                          │
│ (Namespace: ingress-nginx)                            │
│                                                       │
│ • Runs active NGINX master/worker processes           │
│ • Listens for incoming HTTP/HTTPS connections         │
│ • Automatically generates nginx.conf from K8s Ingress │
└───────────────────────────────────────────────────────┘
```

#### What happens:
1. The packet hits the local Kubernetes entry point on port `80`/`443`.
2. The **Ingress-Nginx Controller** (a Pod running inside the `ingress-nginx` namespace) receives this request.
3. **Crucial distinction:** An `Ingress` resource in Kubernetes (like `ingress-srv.yaml`) is **just a configuration file (data)**. The `ingress-nginx-controller` is the **actual running software (NGINX reverse proxy)** that reads that configuration and updates its internal `nginx.conf`.

#### 📁 Configuration Associated:
- **File:** [infra/k8s/ingress-srv.yaml](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/infra/k8s/ingress-srv.yaml)
- **Relevant Lines:**
  ```yaml
  apiVersion: networking.k8s.io/v1
  kind: Ingress
  metadata:
    name: ingress-service
    annotations:
      kubernetes.io/ingress.class: nginx
      nginx.ingress.kubernetes.io/use-regex: 'true'
  ```

#### 🔍 Hidden Details:
- The controller continuously watches the Kubernetes API server for `Ingress` resources.
- When you apply `ingress-srv.yaml`, the controller translates your YAML rules into native Nginx server blocks dynamically without restarting Nginx.

---

### Step 3: Ingress Routing & Path Matching

```text
 Incoming Request:
 Host: ticketing.dev
 Path: /api/users/currentuser
          │
          ▼
┌────────────────────────────────────────────────────────┐
│ 1. Host Header Check:                                  │
│ Does "Host: ticketing.dev" match Ingress spec.rules?   │
└─────────┬──────────────────────────────────┬───────────┘
          │ YES                              │ NO
          ▼                                  ▼
┌──────────────────────────────────┐   ┌─────────────────┐
│ 2. Path Regex Match:             │   │ Return 404 /    │
│ Does path match /api/users/?(.*)?│   │ Default Backend │
└─────────┬────────────────────────┘   └─────────────────┘
          │ YES
          ▼
┌────────────────────────────────────────────────────────┐
│ Selected Backend Destination:                          │
│ Service Name: auth-srv                                 │
│ Port: 3000                                             │
└────────────────────────────────────────────────────────┘
```

#### What happens:
1. The Nginx controller inspects the HTTP headers:
   - `Host: ticketing.dev`
   - `Request URI: /api/users/currentuser`
2. It matches rule `host: ticketing.dev`.
3. It evaluates the path regex `/api/users/?(.*)` against `/api/users/currentuser`. Since it matches, it identifies the target backend: `auth-srv:3000`.

#### 📁 Configuration Associated:
- **File:** [infra/k8s/ingress-srv.yaml](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/infra/k8s/ingress-srv.yaml#L9-L19)
- **Relevant Lines:**
  ```yaml
  spec:
    rules:
      - host: ticketing.dev
        http:
          paths:
            - path: /api/users/?(.*)
              pathType: ImplementationSpecific
              backend:
                service:
                  name: auth-srv
                  port:
                    number: 3000
  ```

---

### Step 4: Service Discovery & Endpoint Resolution

```text
┌────────────────────────────────────────────────────────┐
│ Ingress Controller queries Kubernetes Endpoints API:   │
│ "Where are the active Pods for service 'auth-srv'?"   │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ Kubernetes Service: auth-srv (ClusterIP)               │
│ Config: selector: { app: "auth" }                      │
│                                                        │
│ Auto-discovers Pods labeled "app: auth":               │
│ └── Endpoint: 10.244.0.18:3000 (Auth Pod IP)           │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ Ingress-Nginx directly proxies the TCP/HTTP stream     │
│ to Pod IP: 10.244.0.18:3000                            │
└────────────────────────────────────────────────────────┘
```

#### What happens:
1. The Ingress needs to forward the request to the `auth-srv` service.
2. In Kubernetes, a **Service** (`auth-srv`) is a virtual abstraction defined by a selector (`app: auth`).
3. Kubernetes maintains an **Endpoints** (or `EndpointSlice`) list that maps the service `auth-srv` to the actual Pod internal IP addresses (e.g. `10.244.0.18:3000`).
4. **Behind the scenes:** Ingress-Nginx bypasses standard `kube-proxy` cluster IP routing and directly forwards HTTP traffic to the Pod's internal IP address for lower latency and session affinity support.

#### 📁 Configuration Associated:
- **File:** [infra/k8s/auth-depl.yaml](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/infra/k8s/auth-depl.yaml#L25-L36)
- **Relevant Lines:**
  ```yaml
  apiVersion: v1
  kind: Service
  metadata:
    name: auth-srv
  spec:
    selector:
      app: auth        # <-- Matches Pod label 'app: auth'
    ports:
      - name: auth
        protocol: TCP
        port: 3000       # <-- Service Port
        targetPort: 3000 # <-- Container Port inside Pod
  ```

---

### Step 5: Pod & Container Ingestion

```text
┌────────────────────────────────────────────────────────┐
│ Container Virtual Ethernet Interface (veth) inside Pod │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ Pod Linux Kernel Network Stack                         │
│ Routes incoming packet on Port 3000                    │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ Node.js Process (Port 3000)                            │
│ • libuv event loop accepts TCP socket connection       │
│ • Node http.createServer instantiates req & res        │
│ • Hands execution over to Express app middleware chain │
└────────────────────────────────────────────────────────┘
```

#### What happens:
1. The TCP packet arrives on the Pod's network interface.
2. The Node.js process listening on port `3000` (`app.listen(3000)`) receives the HTTP request.
3. Node's `http` module parses the stream into standard `req` and `res` objects and hands them off to the Express middleware pipeline.

#### 📁 Configuration Associated:
- **File:** [infra/k8s/auth-depl.yaml](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/infra/k8s/auth-depl.yaml#L1-L24)
- **Deployment Spec:**
  ```yaml
  template:
    metadata:
      labels:
        app: auth
    spec:
      containers:
        - name: auth
          image: mehul3288/auth
          env:
            - name: JWT_KEY
              valueFrom:
                secretKeyRef:
                  name: jwt-secret
                  key: JWT_KEY
  ```

---

### Step 6: Express.js Middleware & Route Execution

```text
 Incoming Express Request: req (GET /api/users/currentuser)
          │
          ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 1. app.set("trust proxy", true)                                        │
│ • Reads 'X-Forwarded-Proto: https' and 'X-Forwarded-For' headers        │
│ • Marks req.secure = true (allows secure cookies over HTTPS via proxy) │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 2. app.use(json())                                                     │
│ • Reads and parses incoming JSON body into req.body                    │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 3. app.use(cookieSession({ signed: false, secure: true }))             │
│ • Parses Cookie header ('express:sess')                                │
│ • Decodes base64 session data into req.session                         │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 4. Route Matching Pipeline:                                            │
│ • currentUserRouter                                                    │
│ • signinRouter                                                         │
│ • signoutRouter                                                        │
│ • signupRouter                                                         │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼ (Matches GET /api/users/currentuser)
┌────────────────────────────────────────────────────────────────────────┐
│ 5. currentUser Middleware (auth/src/middlewares/current-user.ts)       │
│ • Checks if req.session?.jwt exists                                    │
│ • Verifies JWT using process.env.JWT_KEY                               │
│ • Sets req.currentUser = payload (or null if invalid)                  │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 6. Route Handler (auth/src/routes/current-user.ts)                     │
│ • Executes: res.send({ currentUser: req.currentUser || null })        │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 7. HTTP 200 OK Response Stream                                         │
│ • Headers: Content-Type: application/json; charset=utf-8               │
│ • Body: { "currentUser": { "id": "...", "email": "..." } }             │
│ • Traverses back through Pod ─► Ingress-Nginx ─► Browser               │
└────────────────────────────────────────────────────────────────────────┘
```

#### What happens inside [auth/src/index.ts](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/auth/src/index.ts):

1. **`app.set("trust proxy", true)`**:
   - Because Ingress-Nginx acts as a reverse proxy in front of Express, the client's original HTTPS connection terminated at Ingress.
   - Ingress passes headers like `X-Forwarded-Proto: https`.
   - `trust proxy: true` tells Express to trust these proxy headers so that `cookieSession` with `secure: true` will allow cookies over HTTPS!
2. **`app.use(json())`**:
   - Parses incoming request body payloads into JSON (`req.body`).
3. **`app.use(cookieSession({ signed: false, secure: true }))`**:
   - Reads the `req.headers.cookie`, extracts the session token, and populates `req.session`.
4. **Router Execution**:
   - `app.use(currentUserRouter)` checks if the method is `GET` and path is `/api/users/currentuser`.
   - The route handler in `routes/current-user.ts` extracts `req.currentUser` and responds with `{ currentUser: ... }`.

---

## 3. Configuration to Code Mapping Matrix

| Step | Component | Config / Source File | Key Identifiers / Wiring |
| :--- | :--- | :--- | :--- |
| **1. DNS** | Client OS | `hosts` file | `127.0.0.1 ticketing.dev` |
| **2. Ingress Entry** | Ingress-Nginx | [infra/k8s/ingress-srv.yaml](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/infra/k8s/ingress-srv.yaml) | `host: ticketing.dev` |
| **3. Path Routing** | Ingress-Nginx | [infra/k8s/ingress-srv.yaml](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/infra/k8s/ingress-srv.yaml#L13-L19) | `path: /api/users/?(.*)` <br/> `service.name: auth-srv:3000` |
| **4. Service Discovery** | K8s ClusterIP Service | [infra/k8s/auth-depl.yaml](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/infra/k8s/auth-depl.yaml#L25-L36) | `metadata.name: auth-srv` <br/> `selector.app: auth` <br/> `port: 3000` -> `targetPort: 3000` |
| **5. Pod Deployment** | K8s Deployment | [infra/k8s/auth-depl.yaml](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/infra/k8s/auth-depl.yaml#L1-L24) | `metadata.labels.app: auth` <br/> `image: mehul3288/auth` <br/> `env: JWT_KEY` |
| **6. App Server** | Express App | [auth/src/index.ts](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/auth/src/index.ts) | `app.listen(3000)` <br/> `app.set("trust proxy", true)` |
| **7. Route Handler** | Express Router | [auth/src/routes/current-user.ts](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/auth/src/routes/current-user.ts) | `router.get("/api/users/currentuser", ...)` |

---

## 4. Summary of "Hidden" Magic Demystified

1. **Why `ticketing.dev` works locally**:
   Kubernetes doesn't know domain names on your machine. Your local OS `hosts` file redirects `ticketing.dev` to `127.0.0.1`.
2. **Why Ingress receives traffic**:
   Ingress-Nginx binds directly to host ports `80` and `443` through Docker Desktop's port mapping.
3. **How Ingress finds your Pod**:
   Ingress matches the `ingress-srv.yaml` rules, looks up the Service `auth-srv`, finds the Pods with label `app: auth` through Kubernetes Endpoints, and routes directly to the Pod IP.
4. **Why `trust proxy` is required in Express**:
   Because Ingress-Nginx acts as a reverse proxy, the client's HTTPS connection terminates at Ingress-Nginx. Express sees incoming HTTP from an internal IP unless `app.set('trust proxy', true)` is set to trust `X-Forwarded-Proto`.
