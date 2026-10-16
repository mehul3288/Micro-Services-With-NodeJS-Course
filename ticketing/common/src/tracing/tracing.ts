import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";

export const startTracing = (serviceName: string): NodeSDK | null => {
    // Allow disabling tracing in test environments or via env
    if (process.env.ENABLE_TRACING === "false" || process.env.NODE_ENV === "test") {
        return null;
    }

    if (process.env.OTEL_DEBUG === "true") {
        diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
    }

    const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://jaeger-srv:4318/v1/traces";

    const traceExporter = new OTLPTraceExporter({
        url: otlpEndpoint,
    });

    const sdk = new NodeSDK({
        serviceName,
        traceExporter,
        instrumentations: [
            getNodeAutoInstrumentations({
                // Disable fs instrumentation to keep traces clean and high-performance
                "@opentelemetry/instrumentation-fs": {
                    enabled: false,
                },
            }),
        ],
    });

    try {
        sdk.start();
        console.log(`[Tracing] OpenTelemetry initialized for ${serviceName} -> ${otlpEndpoint}`);
    } catch (err) {
        console.error(`[Tracing] Failed to initialize OpenTelemetry for ${serviceName}:`, err);
    }

    process.on("SIGTERM", () => {
        sdk.shutdown()
            .then(() => console.log(`[Tracing] SDK terminated for ${serviceName}`))
            .catch((err) => console.error(`[Tracing] Error terminating SDK for ${serviceName}:`, err));
    });

    return sdk;
};
