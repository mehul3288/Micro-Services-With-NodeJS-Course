# Microservices & Backend Architecture Notes

---

## 1. Node.js & TypeScript Fundamentals

### Why `@types/node` is Always Required
- TypeScript itself only knows standard ECMAScript/JavaScript globals (like `Array`, `Promise`, `Math`, `JSON`).
- It does **not** include built-in types for Node.js-specific runtime globals and core modules (`process.env`, `Buffer`, `__dirname`, `path`, `fs`, `http`, etc.).
- `@types/node` provides the ambient type definitions so TypeScript and IDEs recognize Node.js APIs without compile-time errors.

### TypeScript Type Augmentation (Declaration Merging)
- **The Problem:** Express's default `Request` interface (from `@types/express`) only contains standard properties (`req.body`, `req.params`, `req.query`, etc.). Directly setting a custom property like `req.currentUser = payload;` triggers a TypeScript compile error: `Property 'currentUser' does not exist on type 'Request'`.
- **The Solution:** Use `declare global` to reach into the global Express type definitions and merge our custom property into the existing `Request` interface:
  ```typescript
  interface UserPayload {
    id: string;
    email: string;
  }

  declare global {
    namespace Express {
      interface Request {
        currentUser?: UserPayload;
      }
    }
  }
  ```
- **Detailed Breakdown:**

    - `declare global`: Tells TypeScript, "I want to modify a type in the global environment, not just in this single file."
    - `namespace Express + interface Request`: Finds the existing `Request` interface provided by `@types/express`.
    - `Declaration Merging`: In TypeScript, when two interfaces have the same name in the same namespace, TypeScript merges them together. the property of both interfaces will be combined together. the property in @types/express + the property in our code

- **Benefits:** Eliminates type errors and provides global autocomplete and type safety across all route handlers and middlewares without casting with `as any`.

---

## 2. Docker & Containerized Development

### File Watching & Polling in Docker (Host vs Container Sync)
- **Linux `inotify` limitations:** When files are synced into a Docker container from a Windows host (e.g., via Skaffold or volume mounts), the Linux kernel inside the container does not reliably receive native `inotify` file-change events for nested subdirectories.
- **Why Polling is Used:** File watchers with polling enabled (`--poll` in `ts-node-dev` or `-L`/`--legacy-watch` in `nodemon`) actively inspect file timestamps on a timer, guaranteeing 100% reliable hot-reloading regardless of virtualization or host OS quirks.
- **Performance:** Polling scoped strictly to the `src/` directory (tens of files) consumes negligible CPU resources.

---

## 3. Error Handling Architecture

### Abstract Classes vs. Interfaces for Custom Errors
- **TypeScript Type Erasure:** Interfaces are completely removed during compilation to JavaScript. They do not exist at runtime, so `if (err instanceof SomeInterface)` is invalid syntax.
- **Abstract Classes in JavaScript:** Abstract classes compile into real JavaScript constructor functions/classes that exist in the runtime prototype chain.
- **Polymorphic Error Handling:** By having all custom error classes (`RequestValidationError`, `DatabaseConnectionError`, `NotFoundError`, `BadRequestError`) extend a base abstract class (`CustomError`), the global error-handling middleware can handle all application errors with a single check:
  ```typescript
  if (err instanceof CustomError) {
    return res.status(err.statusCode).send({ errors: err.serializeError() });
  }
  ```

---

## 4. Express 4 vs. Express 5

| Feature | Express 4 | Express 5 |
| :--- | :--- | :--- |
| **Async Route Handlers** | Does not natively catch rejected Promises. Thrown errors in `async` functions cause requests to hang indefinitely unless `next(err)` or `express-async-errors` is used. | Natively catches rejected Promises from `async` functions and automatically forwards them to the error-handling middleware. |
| **Catch-All Wildcard Routes** | Allowed bare wildcard string: `app.all('*', ...)` | Upgraded `path-to-regexp`; requires named wildcards or regex: `app.all('*splat', ...)` or catch-all middleware `app.use(...)`. |

---

## 5. Mongoose & Database Modeling

### Schema vs. Model
- **Schema (The Blueprint):** Defines the structure, data types, validation rules, and lifecycle hooks for documents in a MongoDB collection.
- **Model (The Interface):** The compiled JavaScript class created from the schema that provides methods to create, query, update, and delete documents in MongoDB (e.g., `User.find()`, `User.findOne()`).

### The `User.build()` Pattern
- **Constructor Looseness:** In Mongoose, `new Model(doc)` is loosely typed (`doc?: AnyObject`) to accommodate internal document hydration and MongoDB query results with populated fields.
- **Type-Safe Factory Method:** Creating a custom static method `User.build(attrs: UserAttrs)` forces TypeScript to strictly validate required parameters at compile time, catching typos and missing fields before runtime.

### Modern Mongoose `pre("save")` Middleware
- In modern Mongoose (v6+), `async` hooks return a Promise that Mongoose automatically waits for.
- Passing and calling `done()` inside an `async` middleware hook is deprecated.
  ```typescript
  userSchema.pre("save", async function () {
    if (this.isModified("password")) {
      const hashed = await Password.toHash(this.password);
      this.password = hashed;
    }
  });
  ```

---

## 6. Cryptography & Memory Management

### Buffers in Node.js
- **Definition:** A global class in Node.js representing a fixed-size chunk of raw binary memory allocated outside the V8 JavaScript garbage collection heap.
- **Purpose:** Used for high-performance handling of binary streams (TCP packets, file I/O, encryption keys, and cryptographic hashes).
- **Representation:** An array of bytes where each byte is an integer between `0` and `255` (displayed in hexadecimal `00` to `ff`).

### Constant-Time Comparison (`crypto.timingSafeEqual`)
- Standard string equality (`===`) exits early as soon as the first mismatched character is encountered, creating slight variations in execution time.
- **Timing Attack Prevention:** Attackers can measure response time differences to guess passwords, signatures, or HMAC tokens character-by-character. `timingSafeEqual(bufA, bufB)` compares two byte buffers in constant time regardless of where mismatches occur.

---

## 7. Networking, Reverse Proxies & Ingress

### `app.set("trust proxy", true)`
- **The Reverse Proxy Setup:** In Kubernetes, external HTTPS traffic is received by the Ingress-NGINX controller (which terminates SSL) and forwarded internally to the application pod over plain HTTP.
- **The Problem:** Express by default sees incoming HTTP traffic on port 3000 and marks `req.secure = false`. As a result, session cookies configured with `secure: true` (`cookie-session`) will refuse to attach or send cookies.
- **The Solution:** Enabling `"trust proxy"` instructs Express to trust the `X-Forwarded-Proto: https` header sent by the Ingress proxy, setting `req.secure = true` and enabling secure cookie transmission over HTTPS.
