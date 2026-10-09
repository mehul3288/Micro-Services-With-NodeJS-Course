# Ingress Nginx & Next.js Build-Client Architecture (Local vs Production)

This guide provides a comprehensive explanation of how **Next.js (App Router / SSR)** communicates with your microservices through **Kubernetes Ingress-Nginx**, why `build-client` configuration differs between **Local Development** and **Cloud Production (DigitalOcean)**, and how networking routes requests from both the browser and the server.

---

## 1. Quick Summary & Core Concepts

### Why does `build-client.js` need different configurations?
* **In the Browser (Client-side)**: The browser is aware of the current URL origin (`https://yourdomain.com`). A relative URL like `baseURL: '/'` automatically resolves to the domain in the address bar.
* **In Next.js (Server-side / SSR)**: Next.js runs inside a Kubernetes container (Node.js runtime). It has no browser address bar. If you call `/api/users/currentuser`, Axios will fail because it does not know what host or port to send the request to. A full `baseURL` is required.

---

## 2. Ingress Accessibility: Outside vs Inside the Cluster

When Ingress-Nginx is installed in your Kubernetes cluster, it creates two interfaces:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                              OUTSIDE CLUSTER                                │
│                     (Browser / External Internet)                           │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                         [Public DNS: yourdomain.com]
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     DigitalOcean Cloud Load Balancer                        │
│                         (Public IP: 143.198.x.x)                            │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
┌──────────────────────────────────────┼──────────────────────────────────────┐
│ KUBERNETES CLUSTER                   │                                      │
│                                      ▼                                      │
│                    ┌───────────────────────────────────┐                    │
│                    │    Ingress-Nginx Controller       │                    │
│                    │         (Nginx Pods)              │                    │
│                    └─────────────────▲─────────────────┘                    │
│                                      │                                      │
│             [Cluster-Internal DNS / Service Name]                           │
│   `http://ingress-nginx-controller.ingress-nginx.svc.cluster.local`         │
│                                      │                                      │
│                    ┌─────────────────┴─────────────────┐                    │
│                    │      Next.js Pod (client-srv)     │                    │
│                    └───────────────────────────────────┘                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

1. **Outside the Cluster**:
   * Kubernetes creates an Ingress Service of type `LoadBalancer`.
   * DigitalOcean provisions an external cloud Load Balancer with a **Public IP**.
   * Your custom domain points via DNS (A record) to this Public IP.
2. **Inside the Cluster**:
   * Kubernetes sets up an internal Service address: `http://ingress-nginx-controller.ingress-nginx.svc.cluster.local`.
   * Any pod within the cluster can communicate directly with Ingress-Nginx without going over the public internet.

---

## 3. Scenario 1: Local Development (Skaffold / Minikube / Docker Desktop)

### Why we used Internal Cluster DNS + Host Header
* In local development, `ticketing.dev` is a fake domain that only exists in your host operating system's `hosts` file (`127.0.0.1 ticketing.dev`).
* The Next.js container running inside the Kubernetes cluster **cannot** resolve `ticketing.dev` because it uses Kubernetes CoreDNS, not your laptop's `hosts` file.
* **Solution**:
  1. Point `baseURL` directly to the internal Ingress controller service:
     `http://ingress-nginx-controller.ingress-nginx.svc.cluster.local`
  2. Manually pass the `Host: 'ticketing.dev'` header so Ingress-Nginx knows which routing rules from `ingress-srv.yaml` to apply.

### Local Development Architecture Diagram

```text
+-----------------------------------------------------------------------------+
|                               LOCAL MACHINE                                 |
|                                                                             |
|  1. Developer types "https://ticketing.dev"                                 |
|     (/etc/hosts maps ticketing.dev -> 127.0.0.1)                            |
|                                                                             |
|  +-----------------------------------------------------------------------+  |
|  | KUBERNETES CLUSTER (Docker Desktop / Minikube)                        |  |
|  |                                                                       |  |
|  |  +-----------------------------------------------------------------+  |  |
|  |  | Ingress-Nginx Controller (Port 80/443)                          |  |  |
|  |  | Routing rule: host == "ticketing.dev"                           |  |  |
|  |  |   - path: /api/users/*  --> auth-srv:3000                       |  |  |
|  |  |   - path: /*            --> client-srv:3000                     |  |  |
|  |  +------------------+-----------------------------^----------------+  |  |
|  |                     | (Routes /)                  |                   |  |
|  |                     v                             |                   |  |
|  |  +-------------------------------------+          | (SSR Request)     |  |
|  |  | Next.js Pod (client-srv)            |          | baseURL: internal |  |
|  |  |                                     |          | Host:             |  |
|  |  | buildClient() runs during SSR:      |          | "ticketing.dev"   |  |
|  |  | baseURL: http://ingress-nginx-...   +----------+                   |  |
|  |  | headers: { Host: 'ticketing.dev' }  |                              |  |
|  |  +-------------------------------------+                              |  |
|  +-----------------------------------------------------------------------+  |
+-----------------------------------------------------------------------------+
```

---

## 4. Scenario 2: Cloud Production (DigitalOcean + Purchased Domain)

### Why we switch to the purchased domain
* In production on DigitalOcean, you own a real, publicly resolvable domain (e.g., `www.my-ticketing-app.com`).
* DNS servers worldwide (including inside your Kubernetes cluster) resolve this domain to the DigitalOcean Load Balancer's public IP.
* When Next.js makes an SSR request to `http://www.my-ticketing-app.com`, Axios automatically adds `Host: www.my-ticketing-app.com`.
* Ingress-Nginx receives the request with the correct `Host` header and routes it according to your production Ingress configuration.
* **Benefit**: No need to hardcode cluster-internal service paths or namespace names that might differ across cloud providers.

### Production Architecture Diagram

```text
+-----------------------------------------------------------------------------+
|                                INTERNET                                     |
|                                                                             |
|  User visits: https://www.my-ticketing-app.com                              |
|  (Public DNS points domain to DigitalOcean Load Balancer IP)                |
|                                                                             |
+--------------------------------------|--------------------------------------+
                                       |
                                       v
+-----------------------------------------------------------------------------+
|                      DIGITALOCEAN CLOUD LOAD BALANCER                       |
|                             (Public IP Address)                             |
+--------------------------------------|--------------------------------------+
                                       |
                                       v
+-----------------------------------------------------------------------------+
| KUBERNETES CLUSTER (DigitalOcean DOKS)                                      |
|                                                                             |
|  +-----------------------------------------------------------------------+  |
|  | Ingress-Nginx Controller                                              |  |
|  | Routing rule: host == "www.my-ticketing-app.com"                      |  |
|  |   - path: /api/users/*   --> auth-srv:3000                            |  |
|  |   - path: /api/tickets/* --> tickets-srv:3000                         |  |
|  |   - path: /*             --> client-srv:3000                          |  |
|  +-------------------|-------------------------------^-------------------+  |
|                      |                               |                      |
|       [1] Route /    |                               | [3] SSR Axios Call   |
|                      v                               |     baseURL: domain  |
|  +---------------------------------------+           |                      |
|  | Next.js Pod (client-srv)              |           |                      |
|  |                                       +-----------+                      |
|  | [2] SSR page.js executes              |                                  |
|  |     Calls buildClient()               |                                  |
|  |     baseURL: http://your-domain.com   |                                  |
|  +---------------------------------------+                                  |
+-----------------------------------------------------------------------------+
```

---

## 5. Execution Flow Comparison: Browser vs Server-Side (SSR)

### Flow A: Client-Side Action (Browser)
* **Trigger**: User clicks a button in the browser (e.g. "Create Ticket", "Sign In").
* **Where code runs**: Inside the user's browser engine (Chrome, Firefox, Safari).
* **Base URL**: `'/'` (relative path).
* **Cookies**: Automatically attached by the browser.

```text
[ User Browser ]
       |
       | 1. POST /api/tickets { title, price } (baseURL: '/')
       v
[ DigitalOcean Load Balancer ]
       |
       | 2. Forwards to Ingress-Nginx
       v
[ Ingress-Nginx Controller ]
       |
       | 3. Matches /api/tickets -> routes to tickets-srv:3000
       v
[ tickets-srv Pod ]
       |
       | 4. Creates ticket in MongoDB & returns JSON response
       v
[ Ingress-Nginx ] --> [ Load Balancer ] --> [ User Browser ] (Updated UI)
```

---

### Flow B: Server-Side Rendering (SSR)
* **Trigger**: User visits the page directly or presses Refresh (`F5`).
* **Where code runs**: Inside the Node.js process within the `client-srv` pod.
* **Base URL**: `http://www.your-domain.com` (Production) or `http://ingress-nginx...` (Local).
* **Cookies**: Extracted from incoming Next.js request headers via `headers().get('cookie')` and forwarded explicitly.

```text
[ User Browser ]
       |
       | 1. GET https://www.your-domain.com/
       v
[ DigitalOcean Load Balancer ]
       |
       | 2. Forwards to Ingress-Nginx
       v
[ Ingress-Nginx Controller ]
       |
       | 3. Matches / -> routes to client-srv:3000
       v
[ Next.js Pod (client-srv) ]
       |
       | 4. Next.js starts rendering page.js on the server.
       |    Needs currentUser data before it can produce HTML!
       |    Runs buildClient() with baseURL: http://www.your-domain.com
       |    Forwards incoming Cookie header.
       |
       | 5. GET http://www.your-domain.com/api/users/currentuser
       v
[ DigitalOcean Load Balancer / Ingress-Nginx ]
       |
       | 6. Matches /api/users/* -> routes to auth-srv:3000
       v
[ auth-srv Pod ]
       |
       | 7. Reads cookie, validates JWT, returns JSON { currentUser: { ... } }
       v
[ Next.js Pod (client-srv) ]
       |
       | 8. Receives user data, injects into React components, renders full HTML.
       v
[ Ingress-Nginx ] --> [ Load Balancer ] --> [ User Browser ] (Displays full page)
```

---

## 6. Implementation Reference for `build-client.js`

To support both local development and production seamlessly without modifying code manually:

```javascript
import axios from 'axios';
import { headers } from 'next/headers';

export default async function buildClient() {
  if (typeof window === 'undefined') {
    // -------------------------------------------------------------
    // SERVER-SIDE (SSR)
    // -------------------------------------------------------------
    const headersList = await headers();
    const cookie = headersList.get('cookie');

    // In Production: process.env.BASE_URL = 'http://www.your-domain.com'
    // In Local Dev:   process.env.BASE_URL = 'http://ingress-nginx-controller.ingress-nginx.svc.cluster.local'
    const baseURL =
      process.env.BASE_URL ||
      'http://ingress-nginx-controller.ingress-nginx.svc.cluster.local';

    return axios.create({
      baseURL,
      headers: {
        'X-Forwarded-Proto': headersList.get('x-forwarded-proto') || 'https',
        Host: headersList.get('host') || 'ticketing.dev',
        Cookie: cookie ? decodeURIComponent(cookie) : undefined,
      },
    });
  } else {
    // -------------------------------------------------------------
    // BROWSER-SIDE (Client)
    // -------------------------------------------------------------
    return axios.create({
      baseURL: '/',
    });
  }
}
```

---

## 7. Key Comparison Summary Table

| Feature | Local Development (Skaffold) | Production (DigitalOcean) |
| :--- | :--- | :--- |
| **Domain** | `ticketing.dev` (fake local domain) | `www.your-domain.com` (real domain) |
| **DNS Resolution** | Handled by OS `/etc/hosts` file | Handled by global public DNS records |
| **Cluster Ingress Entry** | Port-forwarding / Minikube tunnel / Docker bridge | DigitalOcean Cloud Load Balancer (Public IP) |
| **SSR `baseURL`** | `http://ingress-nginx-controller.ingress-nginx.svc.cluster.local` | `http://www.your-domain.com` |
| **Host Header during SSR** | Explicitly set to `ticketing.dev` | Automatically set by Axios to domain |
| **Browser `baseURL`** | `'/'` | `'/'` |
| **Cookie Forwarding (SSR)** | Required (extracted from Next.js headers) | Required (extracted from Next.js headers) |
