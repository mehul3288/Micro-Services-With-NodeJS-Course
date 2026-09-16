# Kubernetes: Load Balancer, Ingress & Ingress Controller Explained

---

## 1. The Core Problem: Routing Outside Traffic to Multiple Microservices

In our microservices architecture, we run several distinct services inside the Kubernetes cluster:
- **Posts Service** (`posts-clusterip-srv:4000`)
- **Comments Service** (`comments-srv:4001`)
- **Query Service** (`query-srv:4002`)
- **Moderation Service** (`moderation-srv:4003`)
- **Event Bus** (`event-bus-srv:4005`)

### Why can't the React app talk directly to these services?
1. **Private Network**: By default, Pods and `ClusterIP` Services only exist on an internal cluster network (`10.x.x.x`). They have no public IP and cannot be reached directly from outside the cluster.
2. **Coupling**: We don't want the React app to know about individual ports (`4000`, `4001`, `4002`) or internal service names.
3. **CORS & Domain Issues**: If each service had its own external IP/port, the frontend would constantly run into CORS issues and configuration headaches.

We need a single external entry point that inspects incoming HTTP requests and routes them internally based on URL path or domain.

---

## 2. The Solution Hierarchy: NodePort vs. LoadBalancer vs. Ingress

Kubernetes offers different ways to expose services to the outside world:

| Mechanism | How It Works | Limitations / Use Case |
| :--- | :--- | :--- |
| **NodePort** | Opens a static port (range 30000–32767) directly on every cluster Node. | Bad for production: Non-standard ports, exposes node IPs directly, no intelligent routing. Useful only for local dev. |
| **LoadBalancer Service** | Asks the cloud provider (AWS/GCP/Azure) to spin up an external cloud load balancer targeting a single service. | **Expensive & 1-to-1**: 10 microservices = 10 cloud load balancers ($$$). No Layer 7 path-based routing. |
| **Ingress + Ingress Controller** | A single Cloud LoadBalancer routes all traffic to an **Ingress Controller Pod**, which uses software rules to route traffic internally. | **Best Practice (Layer 7)**: 1 external IP, handles multiple microservices, SSL termination, path-based and host-based routing. |

---

## 3. End-to-End Architecture & Traffic Flow

### Visual Flow Diagram Architecture Map

```text
+-------------------------------------------------------------+
| Browser / React Client                                      |
+------------------------------+------------------------------+
                               |
                               |  HTTP Request (Single Domain)
                               v
+-------------------------------------------------------------+
| Cloud Load Balancer (AWS ALB / GCP Load Balancer)           |
+------------------------------+------------------------------+
                               |
                               |  Port 80 / 443
                               v
+-------------------------------------------------------------+
| Kubernetes Cluster                                          |
|                                                             |
|   +-------------------------------------------------------+ |
|   | Ingress Controller (e.g., NGINX Pod)                  | |
|   | (Applies routing rules from Ingress YAML)             | |
|   +----+--------------------+--------------------+--------+ |
|        | (Path: /posts)     | (Path: /comments)  | (Query)  |
|        v                    v                    v          |
|   +------------+       +------------+       +------------+  |
|   | Posts Srv  |       |Comments Srv|       | Query Srv  |  |
|   | (Port 4000)|       | (Port 4001)|       | (Port 4002)|  |
|   +----+-------+       +----+-------+       +----+-------+  |
|        |                    |                    |          |
|        v                    v                    v          |
|   +------------+       +------------+       +------------+  |
|   | Posts Pod  |       |Comments Pod|       | Query Pod  |  |
|   +------------+       +------------+       +------------+  |
+-------------------------------------------------------------+
```

---

## 4. Deep Dive: Ingress vs. Ingress Controller

A common source of confusion is treating "Ingress" and "Ingress Controller" as the same thing. In reality, they are two separate parts of a configuration engine:

### A. The Ingress Resource (The Rules)
- A standard Kubernetes YAML file with `kind: Ingress`.
- Contains declarative routing rules:
  - *"If path starts with `/posts`, forward to `posts-clusterip-srv` on port `4000`"*.
  - *"If path starts with `/posts/*/comments`, forward to `comments-srv` on port `4001`"*.
- **Important**: Creating an `Ingress` object does **nothing** by itself unless an Ingress Controller is installed to read it.

### B. The Ingress Controller (The Engine / Reverse Proxy)
- An actual Pod running inside the cluster (commonly `ingress-nginx`, Traefik, HAProxy, or Envoy).
- It constantly watches the Kubernetes API for new or updated `Ingress` resources.
- Whenever you apply an `Ingress` YAML, the Ingress Controller updates its internal routing table (e.g., generates an `nginx.conf`) and proxies HTTP traffic accordingly.

---

## 5. Concrete YAML Example (What Ingress Looks Like)

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ingress-srv
  annotations:
    # Tells Kubernetes which Ingress Controller implementation to use
    kubernetes.io/ingress.class: nginx
spec:
  rules:
    - host: posts.com # (Optional: Host-based routing)
      http:
        paths:
          # Path 1: Create a post -> send to posts service
          - path: /posts
            pathType: Prefix
            backend:
              service:
                name: posts-clusterip-srv
                port:
                  number: 4000

          # Path 2: Comments routes -> send to comments service
          - path: /posts/?(.*)/comments
            pathType: ImplementationSpecific
            backend:
              service:
                name: comments-srv
                port:
                  number: 4001

          # Path 3: Query route -> send to query service
          - path: /posts
            pathType: Prefix
            backend:
              service:
                name: query-srv
                port:
                  number: 4002
```

---

## 6. Key Takeaways & Summary

1. **`LoadBalancer` Service**: Interacts with cloud infrastructure to provision an external IP; typically used to route public traffic to the Ingress Controller Pod itself.
2. **`ClusterIP` Service**: Keeps microservices private within the cluster.
3. **`Ingress Controller`**: A reverse proxy that sits inside the cluster, receives external traffic from the Load Balancer, and directs requests to internal `ClusterIP` services based on URLs and paths.
4. **Result**: Your React frontend needs only **one URL / domain**, and Kubernetes handles all internal microservice dispatching behind the scenes.
