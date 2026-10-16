import pino, { Logger } from "pino";
import pinoHttp from "pino-http";
import { trace, context } from "@opentelemetry/api";

export const createLogger = (serviceName: string): Logger => {
    return pino({
        level: process.env.LOG_LEVEL || "info",
        formatters: {
            log(object: Record<string, any>) {
                const activeSpan = trace.getSpan(context.active());
                if (activeSpan) {
                    const spanContext = activeSpan.spanContext();
                    return {
                        ...object,
                        trace_id: spanContext.traceId,
                        span_id: spanContext.spanId,
                    };
                }
                return object;
            },
        },
        base: { service: serviceName },
        redact: [
            "req.headers.cookie",
            "req.headers.authorization",
            "headers.cookie",
            "headers.authorization",
            "password",
        ],
    });
};

export const createHttpLogger = (serviceName: string) => {
    const logger = createLogger(serviceName);
    return pinoHttp({
        logger,
        autoLogging: {
            ignore: (req) => {
                const url = req.url || "";
                return url.startsWith("/healthz") || url.startsWith("/metrics");
            },
        },
        customLogLevel: (_req, res, err) => {
            if (res.statusCode >= 500 || err) return "error";
            if (res.statusCode >= 400) return "warn";
            return "info";
        },
    });
};
