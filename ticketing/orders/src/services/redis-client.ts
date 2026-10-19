import Redis from "ioredis";

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
        console.warn("[OrdersRedis] Redis connection error (failing open):", err.message);
    });

    redisClient.connect().catch((err) => {
        console.warn("[OrdersRedis] Initial Redis connection failed (failing open):", err.message);
    });
}

export { redisClient };
