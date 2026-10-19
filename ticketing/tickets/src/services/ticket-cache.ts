import Redis from "ioredis";

// In test environment, use in-memory ioredis-mock
let redisClient: Redis;

if (process.env.NODE_ENV === "test") {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const RedisMock = require("ioredis-mock");
    redisClient = new RedisMock();
} else {
    redisClient = new Redis({
        host: process.env.REDIS_HOST || "localhost",
        port: Number(process.env.REDIS_PORT) || 6379,
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
        enableReadyCheck: false,
        lazyConnect: true,
    });

    redisClient.on("error", (err) => {
        // Fail-open: Redis errors should not crash the process
        console.warn("[TicketCache] Redis connection error (failing open):", err.message);
    });
}

// Connect if in production / development
if (process.env.NODE_ENV !== "test") {
    redisClient.connect().catch((err) => {
        console.warn("[TicketCache] Initial Redis connection failed (failing open):", err.message);
    });
}

/**
 * Calculates a jittered TTL to prevent the Cache Stampede (Thundering Herd) problem.
 * Randomizes the TTL by ±10%.
 */
const calculateJitteredTtl = (baseSeconds: number): number => {
    const jitterPercent = (Math.random() * 0.2 - 0.1); // between -0.10 and +0.10
    return Math.round(baseSeconds * (1 + jitterPercent));
};

export const ticketCache = {
    client: redisClient,

    /**
     * Retrieves a single ticket by ID from Redis.
     */
    async get(id: string): Promise<any | null> {
        try {
            const data = await redisClient.get(`ticket:${id}`);
            if (!data) return null;
            return JSON.parse(data);
        } catch (err: any) {
            console.warn(`[TicketCache] Failed to get ticket:${id}:`, err.message);
            return null; // Fail-open
        }
    },

    /**
     * Caches a single ticket with a base TTL of 60 seconds (with ±10% jitter).
     */
    async set(ticket: any): Promise<void> {
        if (!ticket || !ticket.id) return;
        try {
            const ttl = calculateJitteredTtl(60); // 54s to 66s
            await redisClient.set(`ticket:${ticket.id}`, JSON.stringify(ticket), "EX", ttl);
        } catch (err: any) {
            console.warn(`[TicketCache] Failed to set ticket:${ticket.id}:`, err.message);
        }
    },

    /**
     * Retrieves the first page catalog list from Redis.
     */
    async getList(): Promise<{ tickets: any[]; nextCursor: string | null } | null> {
        try {
            const data = await redisClient.get("tickets:list");
            if (!data) return null;
            return JSON.parse(data);
        } catch (err: any) {
            console.warn("[TicketCache] Failed to get tickets:list:", err.message);
            return null; // Fail-open
        }
    },

    /**
     * Caches the first page catalog list with a base TTL of 30 seconds (with ±10% jitter).
     */
    async setList(payload: { tickets: any[]; nextCursor: string | null }): Promise<void> {
        try {
            const ttl = calculateJitteredTtl(30); // 27s to 33s
            await redisClient.set("tickets:list", JSON.stringify(payload), "EX", ttl);
        } catch (err: any) {
            console.warn("[TicketCache] Failed to set tickets:list:", err.message);
        }
    },

    /**
     * Invalidates cached keys.
     * Always clears `tickets:list`. If a ticket ID is passed, also clears `ticket:{id}`.
     */
    async invalidate(id?: string): Promise<void> {
        try {
            const keysToDelete = ["tickets:list"];
            if (id) {
                keysToDelete.push(`ticket:${id}`);
            }
            await redisClient.del(...keysToDelete);
        } catch (err: any) {
            console.warn(`[TicketCache] Failed to invalidate keys:`, err.message);
        }
    },

    /**
     * Gracefully close Redis connection.
     */
    async close(): Promise<void> {
        try {
            await redisClient.quit();
        } catch {}
    },
};
