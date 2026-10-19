import { Request, Response, NextFunction } from "express";
import { redisClient } from "../services/redis-client";

export interface RateLimiterOptions {
    windowSeconds?: number;
    maxRequests?: number;
}

export const createOrderRateLimiter = (options: RateLimiterOptions = {}) => {
    const windowSeconds = options.windowSeconds || 60;
    const maxRequests = options.maxRequests || 10;

    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        // Anti-scalping is keyed on authenticated user ID; fallback to client IP
        const identifier = req.currentUser?.id || req.ip || "unknown";
        const key = `ratelimit:orders:${identifier}`;

        try {
            // Atomic INCR
            const currentRequests = await redisClient.incr(key);

            // If key was just created, set the window TTL
            if (currentRequests === 1) {
                await redisClient.expire(key, windowSeconds);
            }

            const ttl = await redisClient.ttl(key);
            const remaining = Math.max(0, maxRequests - currentRequests);

            res.setHeader("RateLimit-Limit", maxRequests);
            res.setHeader("RateLimit-Remaining", remaining);
            res.setHeader("RateLimit-Reset", Math.max(0, ttl));

            if (currentRequests > maxRequests) {
                res.status(429).send({
                    errors: [
                        {
                            message: "Too many order requests. Anti-scalping rate limit exceeded. Please wait a moment.",
                        },
                    ],
                });
                return;
            }

            next();
        } catch (err: any) {
            // Fail open: Redis failure never blocks checkout
            console.warn("[OrderRateLimiter] Redis error, failing open:", err.message);
            next();
        }
    };
};

export const orderRateLimiter = createOrderRateLimiter();
