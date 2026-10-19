import express, { Request, Response } from "express";
import request from "supertest";
import { createOrderRateLimiter } from "../order-rate-limiter";
import { redisClient } from "../../services/redis-client";

describe("Order Rate Limiter Middleware", () => {
    beforeEach(async () => {
        // Flush mock Redis before each test
        await redisClient.flushall();
    });

    const createTestApp = (limit = 3, windowSeconds = 60) => {
        const app = express();
        app.use(express.json());

        // Fake auth middleware setting currentUser
        app.use((req: Request, res: Response, next) => {
            const userId = req.headers["x-test-user-id"] as string;
            if (userId) {
                req.currentUser = { id: userId, email: `${userId}@test.com` };
            }
            next();
        });

        app.post(
            "/test-order",
            createOrderRateLimiter({ maxRequests: limit, windowSeconds }),
            (req: Request, res: Response) => {
                res.status(201).json({ success: true });
            }
        );

        return app;
    };

    it("allows requests under the rate limit and sets rate limit headers", async () => {
        const app = createTestApp(3);

        const response = await request(app)
            .post("/test-order")
            .set("x-test-user-id", "user-1")
            .expect(201);

        expect(response.headers["ratelimit-limit"]).toBe("3");
        expect(response.headers["ratelimit-remaining"]).toBe("2");
    });

    it("blocks requests with 429 when limit is exceeded", async () => {
        const app = createTestApp(2);

        // Request 1: OK
        await request(app)
            .post("/test-order")
            .set("x-test-user-id", "scalper-user")
            .expect(201);

        // Request 2: OK
        await request(app)
            .post("/test-order")
            .set("x-test-user-id", "scalper-user")
            .expect(201);

        // Request 3: Blocked (429)
        const response = await request(app)
            .post("/test-order")
            .set("x-test-user-id", "scalper-user")
            .expect(429);

        expect(response.body.errors[0].message).toContain("Anti-scalping rate limit exceeded");
        expect(response.headers["ratelimit-remaining"]).toBe("0");
    });

    it("isolates rate limits per user ID", async () => {
        const app = createTestApp(2);

        // User A exhausts their quota
        await request(app).post("/test-order").set("x-test-user-id", "user-A").expect(201);
        await request(app).post("/test-order").set("x-test-user-id", "user-A").expect(201);
        await request(app).post("/test-order").set("x-test-user-id", "user-A").expect(429);

        // User B is fresh and should succeed
        const userBRes = await request(app)
            .post("/test-order")
            .set("x-test-user-id", "user-B")
            .expect(201);

        expect(userBRes.headers["ratelimit-remaining"]).toBe("1");
    });

    it("fails open gracefully if Redis command throws error", async () => {
        const app = createTestApp(2);

        // Simulate Redis failure
        jest.spyOn(redisClient, "incr").mockRejectedValueOnce(new Error("Redis cluster disconnected"));

        const response = await request(app)
            .post("/test-order")
            .set("x-test-user-id", "any-user")
            .expect(201);

        expect(response.body.success).toBe(true);
    });
});
