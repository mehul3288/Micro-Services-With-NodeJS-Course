import client from "prom-client";
import express, { Request, Response, NextFunction } from "express";

export const register = new client.Registry();

// Collect standard default metrics (CPU, memory, event loop lag, GC)
client.collectDefaultMetrics({ register, prefix: "ticketing_" });

// RED Metrics
export const httpRequestDurationHistogram = new client.Histogram({
    name: "ticketing_http_request_duration_seconds",
    help: "Duration of HTTP requests in seconds",
    labelNames: ["method", "route", "status_code"],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [register],
});

export const httpRequestsTotal = new client.Counter({
    name: "ticketing_http_requests_total",
    help: "Total number of HTTP requests processed",
    labelNames: ["method", "route", "status_code"],
    registers: [register],
});

// Pipeline Metrics
export const eventsPublishedCounter = new client.Counter({
    name: "ticketing_events_published_total",
    help: "Total number of events published to Kafka",
    labelNames: ["topic", "event_type"],
    registers: [register],
});

export const eventsConsumedCounter = new client.Counter({
    name: "ticketing_events_consumed_total",
    help: "Total number of events consumed from Kafka",
    labelNames: ["topic", "event_type", "result"], // result: ok, retry, dlq, duplicate
    registers: [register],
});

export const outboxPendingGauge = new client.Gauge({
    name: "ticketing_outbox_pending_events",
    help: "Number of pending outbox events awaiting Kafka dispatch",
    labelNames: ["service"],
    registers: [register],
});

export const outboxPublishLagHistogram = new client.Histogram({
    name: "ticketing_outbox_publish_lag_seconds",
    help: "Time elapsed from event creation in DB to Kafka dispatch",
    labelNames: ["service"],
    buckets: [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10],
    registers: [register],
});

export const circuitBreakerStateGauge = new client.Gauge({
    name: "ticketing_circuit_breaker_state",
    help: "Circuit breaker status (0: closed, 1: half-open, 2: open)",
    labelNames: ["name"],
    registers: [register],
});

export const ordersSweptCounter = new client.Counter({
    name: "ticketing_orders_swept_total",
    help: "Total count of stale orders swept and cancelled by the background reconciler",
    labelNames: ["service"],
    registers: [register],
});

/**
 * Extracts route pattern instead of raw path (e.g. /api/orders/:orderId vs /api/orders/64fa...)
 * to prevent high-cardinality label explosions in Prometheus.
 */
export const getRoutePattern = (req: Request): string => {
    if (req.route && req.route.path) {
        return `${req.baseUrl || ""}${req.route.path}`;
    }
    return req.baseUrl || req.path || "unmatched";
};

export const metricsMiddleware = (req: Request, res: Response, next: NextFunction) => {
    if (req.path === "/metrics" || req.path === "/healthz") {
        return next();
    }

    const start = process.hrtime();

    res.on("finish", () => {
        const diff = process.hrtime(start);
        const durationSeconds = diff[0] + diff[1] / 1e9;
        const route = getRoutePattern(req);
        const method = req.method;
        const statusCode = res.statusCode.toString();

        httpRequestDurationHistogram.observe({ method, route, status_code: statusCode }, durationSeconds);
        httpRequestsTotal.inc({ method, route, status_code: statusCode });
    });

    next();
};

const router = express.Router();

router.get("/metrics", async (_req: Request, res: Response) => {
    try {
        res.set("Content-Type", register.contentType);
        res.end(await register.metrics());
    } catch (err: any) {
        res.status(500).end(err?.message || "Error generating metrics");
    }
});

export { router as metricsRouter };
