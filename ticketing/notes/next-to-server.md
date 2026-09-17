# Next.js to Microservices Auth & SSR Architecture

This guide explains how authentication and Server-Side Rendering (SSR) work between **Next.js (App Router)**, **Kubernetes Ingress NGINX**, and the **Auth Microservice (Express)**.

---

## 1. Overall System Architecture

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USER BROWSER                                   │
│                        (https://ticketing.dev)                              │
│                                                                             │
│   ┌───────────────────────────┐            ┌────────────────────────────┐   │
│   │ Client Component          │            │ Browser Cookie Storage     │   │
│   │ (useRequest Hook)         │            │ (session=eyJ...==)         │   │
│   └─────────────┬─────────────┘            └─────────────▲──────────────┘   │
└─────────────────┼────────────────────────────────────────┼──────────────────┘
                  │                                        │
          [1] HTTPS POST                                   │ [3] Set-Cookie
        /api/users/signup                                  │   session=...
                  │                                        │
┌─────────────────▼────────────────────────────────────────┴──────────────────┐
│                           KUBERNETES CLUSTER                                │
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ Ingress NGINX (Domain: ticketing.dev)                               │   │
│   │ • Terminates HTTPS / SSL                                            │   │
│   │ • Injects X-Forwarded-Proto: https                                  │   │
│   │ • Routes /api/users/* -> auth-srv:3000                              │   │
│   │ • Routes /*           -> client-srv:3000                            │   │
│   └───────────────┬─────────────────────────────────────▲───────────────┘   │
│                   │                                     │                   │
│         [2] Forward Request                   [5] Internal GET              │
│             to Auth Service                 /api/users/currentuser          │
│                   │                                     │                   │
│   ┌───────────────▼───────────┐            ┌────────────┴───────────────┐   │
│   │ auth-srv (Express)        │            │ client-srv (Next.js 15)    │   │
│   │ • cookieSession           │            │ • SSR LandingPage          │   │
│   │ • /api/users/signup       │            │ • buildClient()            │   │
│   └───────────────────────────┘            └────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Sign Up & Sign In Flow (Client-Side Action)

When the user submits the form on `/auth/signup` or `/auth/signin`:

```text
USER / BROWSER              INGRESS NGINX               AUTH SERVICE (Express)          MONGODB
      │                           │                               │                        │
      │ 1. POST /api/users/signup │                               │                        │
      │    { email, password }    │                               │                        │
      │──────────────────────────►│                               │                        │
      │    [HTTPS / TLS]          │                               │                        │
      │                           │ 2. Proxy request with         │                        │
      │                           │    X-Forwarded-Proto: https   │                        │
      │                           │──────────────────────────────►│                        │
      │                           │                               │ 3. Check / Save user   │
      │                           │                               │───────────────────────►│
      │                           │                               │◄───────────────────────│
      │                           │                               │    User saved          │
      │                           │                               │                        │
      │                           │                               │ 4. Generate JWT        │
      │                           │                               │    req.session = {jwt} │
      │                           │                               │    req.secure is TRUE  │
      │                           │                               │    Attach Set-Cookie   │
      │                           │                               │                        │
      │                           │ 5. 201 Created                │                        │
      │                           │    Set-Cookie: session=ey...==│                        │
      │                           │◄──────────────────────────────│                        │
      │ 6. 201 Created            │                               │                        │
      │    Set-Cookie: session=...│                               │                        │
      │◄──────────────────────────│                               │                        │
      │                           │                               │                        │
      ▼                           │                               │                        │
  Browser natively saves          │                               │                        │
  session=eyJ...== in cookies     │                               │                        │
  and navigates to '/'            │                               │                        │
```

---

## 3. Server-Side Rendering (SSR) Flow on Landing Page (`/`)

When the user navigates or refreshes `https://ticketing.dev/`:

```text
USER / BROWSER             NEXT.JS SERVER POD           INGRESS NGINX            AUTH SERVICE (Express)
      │                           │                           │                            │
      │ 1. GET /                  │                           │                            │
      │    Cookie: session=ey...==│                           │                            │
      │──────────────────────────►│                           │                            │
      │                           │                           │                            │
      │                           │ 2. LandingPage SSR runs   │                            │
      │                           │    buildClient() extracts │                            │
      │                           │    Host, Proto & Cookie   │                            │
      │                           │                           │                            │
      │                           │ 3. Internal HTTP GET      │                            │
      │                           │    /api/users/currentuser │                            │
      │                           │    Host: ticketing.dev    │                            │
      │                           │    X-Forwarded-Proto:https│                            │
      │                           │    Cookie: session=...==  │                            │
      │                           │──────────────────────────►│                            │
      │                           │                           │ 4. Route by Host to auth   │
      │                           │                           │───────────────────────────►│
      │                           │                           │                            │
      │                           │                           │ 5. Decodes base64 session  │
      │                           │                           │    Verifies JWT signature  │
      │                           │                           │    Sets req.currentUser    │
      │                           │                           │                            │
      │                           │                           │ 6. 200 OK                  │
      │                           │                           │    { currentUser: {...} }  │
      │                           │                           │◄───────────────────────────│
      │                           │ 7. Forward JSON response  │                            │
      │                           │◄──────────────────────────│                            │
      │                           │                           │                            │
      │                           │ 8. Render HTML with       │                            │
      │                           │    "You are signed in"    │                            │
      │ 9. Return rendered HTML   │                           │                            │
      │◄──────────────────────────│                           │                            │
```

---

## 4. Why `secure: process.env.NODE_ENV !== "test"` Works Now

In `auth/src/app.ts`:
```typescript
app.set("trust proxy", true);
app.use(
  cookieSession({
    signed: false,
    secure: process.env.NODE_ENV !== "test", // Evaluates to TRUE in dev and production
  })
);
```

### How `secure: true` works:
1. `cookie-session` with `secure: true` only emits and decodes cookies if the connection is **secure (HTTPS)** (`req.secure === true`).
2. When the browser makes a request directly to `https://ticketing.dev/api/users/signup`:
   - It hits Ingress via **HTTPS**.
   - Ingress terminates TLS and adds `X-Forwarded-Proto: https`.
   - Express has `app.set("trust proxy", true)`, which instructs Express to trust the `X-Forwarded-Proto` header sent by Ingress.
   - Express sets `req.secure = true`.
   - `cookie-session` sees `req.secure = true` and **successfully attaches the `Set-Cookie` header** to the response.

---

## 5. Why the Previous Next.js Server Action Flow Failed

Here is why using Next.js Server Actions caused the 3 cascading issues earlier:

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ ISSUE 1: 504 Gateway Timeout (Header Forwarding Bug)                      │
├────────────────────────────────────────────────────────────────────────────┤
│ 1. Browser sends Server Action POST (Content-Length: 428, multipart/form) │
│    │                                                                       │
│    ▼                                                                       │
│ 2. Next.js captures ALL incoming headers from browser request              │
│    │                                                                       │
│    ▼                                                                       │
│ 3. Axios sends POST /api/users/signup with Content-Length: 428             │
│    BUT sends a small 50-byte JSON payload                                  │
│    │                                                                       │
│    ▼                                                                       │
│ 4. Ingress / Node waits for remaining 378 bytes until 60s timeout          │
│    ───► RESULT: 504 Gateway Timeout                                        │
└────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────┐
│ ISSUE 2: Missing Set-Cookie Header (req.secure = false)                    │
├────────────────────────────────────────────────────────────────────────────┤
│ 1. Next.js Server Action made internal call: http://ingress-nginx-contr... │
│    │                                                                       │
│    ▼                                                                       │
│ 2. Plain HTTP request arrived at Auth service without X-Forwarded-Proto    │
│    │                                                                       │
│    ▼                                                                       │
│ 3. Express evaluated req.secure as FALSE                                   │
│    │                                                                       │
│    ▼                                                                       │
│ 4. cookieSession({ secure: true }) dropped Set-Cookie completely           │
│    ───► RESULT: Browser never received session cookie                      │
└────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────┐
│ ISSUE 3: currentUser = null (%3D%3D URL Encoding Bug)                     │
├────────────────────────────────────────────────────────────────────────────┤
│ 1. Next.js cookieStore.set() URL-encoded base64 == into %3D%3D             │
│    │                                                                       │
│    ▼                                                                       │
│ 2. Browser forwarded session=eyJ...%3D%3D on page load                    │
│    │                                                                       │
│    ▼                                                                       │
│ 3. Express cookieSession attempted Buffer.from(val, 'base64') on %3D%3D   │
│    │                                                                       │
│    ▼                                                                       │
│ 4. Base64 decode failed -> req.session was {} -> currentUser: null         │
│    ───► RESULT: "You are NOT signed in"                                    │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 6. Comparison: Client `useRequest` vs Next.js Server Actions

| Feature | Client-Side `useRequest` (Option A) | Next.js Server Action (Option B) |
| :--- | :--- | :--- |
| **API Path** | Browser $\rightarrow$ Ingress $\rightarrow$ Auth (Direct) | Browser $\rightarrow$ Next.js Server $\rightarrow$ Ingress $\rightarrow$ Auth |
| **Cookie Jar** | Managed **natively** by the browser | Must manually extract `set-cookie`, call `cookieStore.set()`, and decode |
| **HTTPS `secure: true`** | Works naturally via `X-Forwarded-Proto: https` from Ingress | Requires custom proxy header spoofing over internal HTTP |
| **Body / Headers** | Sent directly with correct `Content-Type: application/json` | Risk of forwarding browser's form headers causing 504 timeouts |
| **Microservice Fit** | Fits standard API Gateway pattern | Adds unnecessary intermediate Node.js server hop for mutations |

---

## 7. The Final Clean `build-client.js`

In [`client/api/build-client.js`](file:///d:/Node%20JS/Micro%20Services%20With%20NodeJS%20Course/ticketing/client/api/build-client.js):

```javascript
import axios from 'axios';
import { headers } from 'next/headers';

export default async function buildClient() {
  if (typeof window === 'undefined') {
    // 1. We are on the Next.js Server (SSR)
    const headersList = await headers();
    const cookie = headersList.get('cookie');

    return axios.create({
      baseURL:
        'http://ingress-nginx-controller.ingress-nginx.svc.cluster.local',
      headers: {
        // Forward protocol so cookieSession(secure: true) knows the client is on HTTPS
        'X-Forwarded-Proto': headersList.get('x-forwarded-proto') || 'https',
        // Forward domain for Ingress host routing rule
        Host: headersList.get('host') || 'ticketing.dev',
        // Forward decoded cookie for session authentication
        Cookie: cookie ? decodeURIComponent(cookie) : undefined,
      },
    });
  } else {
    // 2. We are on the Browser
    return axios.create({
      baseURL: '/',
    });
  }
}
```

---

## 8. Why `X-Forwarded-Proto` Was Automatic in Author's App vs Next.js 15

### In the Author's App (Pages Router `getInitialProps`):
In `client-author/api/build-client.js`:
```javascript
return axios.create({
  baseURL: 'http://ingress-nginx-controller.ingress-nginx.svc.cluster.local',
  headers: req.headers, // Passes raw Node.js request headers in bulk
});
```
- When the user visited `https://ticketing.dev`, Ingress terminated HTTPS and sent the request to Next.js with `x-forwarded-proto: 'https'` already inside `req.headers`.
- Because the author passed the whole `req.headers` object in bulk, `x-forwarded-proto` was forwarded to Express automatically.

### In Next.js 15 App Router:
- There is no `req` object in Server Components (`LandingPage` / `RootLayout`). Next.js provides the Web `Headers` object via `await headers()`.
- Because we pick individual headers manually (`Host`, `Cookie`), we must also explicitly include `'X-Forwarded-Proto': headersList.get('x-forwarded-proto') || 'https'` so Express's `cookie-session` knows the original connection was HTTPS.
- This is completely secure because this internal call is made strictly inside the private Kubernetes cluster overlay network.

---

## 9. What Happens on a Fresh Browser (First-Ever Visit) Lifecycle

Here is the exact step-by-step lifecycle when a user opens `https://ticketing.dev` on a **completely fresh browser** (with no cookies stored):

```text
1. Browser opens "https://ticketing.dev" (First-ever visit)
   │
   ▼
2. Connects to Ingress NGINX over HTTPS (TLS Handshake on port 443)
   │
   ▼
3. Ingress NGINX receives the HTTPS connection.
   Because the connection came over HTTPS, Ingress ALWAYS automatically 
   injects the header:
   ┌──────────────────────────────────────────────┐
   │ X-Forwarded-Proto: https                     │
   │ Host: ticketing.dev                          │
   │ Cookie: (empty / none)                       │
   └──────────────────────────────────────────────┘
   and forwards the request to the Next.js pod (client-srv).
   │
   ▼
4. Inside Next.js (client-srv):
   • LandingPage runs on the server and calls buildClient().
   • await headers() reads the headers sent by Ingress.
   • headersList.get('x-forwarded-proto') is ALREADY 'https'!
   • headersList.get('cookie') is null (no cookies exist yet).
   │
   ▼
5. buildClient() makes internal cluster call:
   GET http://ingress-nginx-controller.../api/users/currentuser
   Headers:
   • Host: ticketing.dev
   • X-Forwarded-Proto: https
   • Cookie: undefined
   │
   ▼
6. Auth Service (auth-srv) receives the request:
   • cookieSession checks req.secure (it is TRUE because of X-Forwarded-Proto: https).
   • But no cookie was sent (req.headers.cookie is empty).
   • req.session is empty ({}).
   • currentUser middleware sees no session.jwt and calls next().
   • Returns: { currentUser: null }.
   │
   ▼
7. Next.js receives { currentUser: null }:
   • LandingPage renders: <h1>You are NOT signed in</h1>
   • Header renders: [Sign Up] [Sign In]
   • Sends full HTML to the browser.
```

### Summary:
- `X-Forwarded-Proto: https` is **always present from the first visit** because Ingress injects it upon receiving the browser's HTTPS connection.
- For a fresh browser with no cookie, `buildClient()` asking Auth cleanly returns `{ currentUser: null }`.
- The `X-Forwarded-Proto` header is essential *after* login so that Express's `cookie-session` (`secure: true`) allows reading and decoding the cookie on server-side requests.
