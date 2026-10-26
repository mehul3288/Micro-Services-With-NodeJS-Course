import { Producer } from "kafkajs";
import { randomUUID } from "crypto";
import { trace, SpanKind, propagation, ROOT_CONTEXT } from "@opentelemetry/api";
import { OutboxEvent } from "./outbox-event";
import { acquireLease } from "./lease";
import { outboxPendingGauge, outboxPublishLagHistogram } from "../metrics/metrics";
import { schemaRegistry } from "../events/schema-registry";

export interface OutboxRelayOptions {
    pollIntervalMs?: number;
    leaseName?: string;
    holderId?: string;
    batchSize?: number;
    serviceName?: string;
}

export class OutboxRelay {
    private producer: Producer;
    private pollIntervalMs: number;
    private leaseName: string;
    private holderId: string;
    private batchSize: number;
    private serviceName: string;
    private isRunning = false;
    private timer?: NodeJS.Timeout;
    private isPolling = false;

    constructor(producer: Producer, options?: OutboxRelayOptions) {
        this.producer = producer;
        this.pollIntervalMs = options?.pollIntervalMs || 200;
        this.leaseName = options?.leaseName || "outbox-relay-lease";
        this.holderId = options?.holderId || process.env.HOSTNAME || randomUUID();
        this.batchSize = options?.batchSize || 100;
        this.serviceName = options?.serviceName || process.env.HOSTNAME || "service";
    }

    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;

        const loop = async () => {
            if (!this.isRunning) return;
            try {
                await this.poll();
            } catch (err) {
                console.error(`[OutboxRelay:${this.holderId}] Error in poll loop:`, err);
            } finally {
                if (this.isRunning) {
                    this.timer = setTimeout(loop, this.pollIntervalMs);
                }
            }
        };

        this.timer = setTimeout(loop, this.pollIntervalMs);
        console.log(`[OutboxRelay] Started with interval ${this.pollIntervalMs}ms (holder: ${this.holderId})`);
    }

    stop(): void {
        this.isRunning = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        console.log(`[OutboxRelay] Stopped (holder: ${this.holderId})`);
    }

    async poll(): Promise<number> {
        if (this.isPolling) return 0;
        this.isPolling = true;

        try {
            const isLeader = await acquireLease(this.leaseName, this.holderId);
            if (!isLeader) {
                return 0; // Another replica holds the lease; yield
            }

            const pending = await OutboxEvent.find({ publishedAt: null })
                .sort({ _id: 1 })
                .limit(this.batchSize);

            try {
                outboxPendingGauge.set({ service: this.serviceName }, pending.length);
            } catch {}

            if (pending.length === 0) {
                return 0;
            }

            let publishedCount = 0;

            for (const event of pending) {
                const rawHeaders = event.headers;
                const cleanHeaders: Record<string, string> = {};

                if (rawHeaders) {
                    if (rawHeaders instanceof Map) {
                        for (const [k, v] of rawHeaders.entries()) {
                            cleanHeaders[k] = String(v);
                        }
                    } else if (typeof rawHeaders === "object") {
                        for (const [k, v] of Object.entries(rawHeaders)) {
                            cleanHeaders[k] = String(v);
                        }
                    }
                }

                cleanHeaders["event-id"] = event.eventId;
                cleanHeaders["event-type"] = event.eventType;
                cleanHeaders["occurred-at"] = event.createdAt ? event.createdAt.toISOString() : new Date().toISOString();

                const extractedContext = propagation.extract(ROOT_CONTEXT, cleanHeaders);
                const tracer = trace.getTracer("@mehul-mrtickets/common");

                await tracer.startActiveSpan(
                    `publish: ${event.topic}`,
                    {
                        kind: SpanKind.PRODUCER,
                        attributes: {
                            "messaging.system": "kafka",
                            "messaging.destination": event.topic,
                            "messaging.event_type": event.eventType,
                            "messaging.event_id": event.eventId,
                        },
                    },
                    extractedContext,
                    async (span) => {
                        try {
                            let encodedValue: Buffer | string = event.payload;
                            try {
                                const rawData = JSON.parse(event.payload);
                                encodedValue = await schemaRegistry.encode(event.topic, event.eventType, rawData);
                            } catch (encodeErr: any) {
                                console.warn(`[OutboxRelay] Schema encode fallback to raw payload for ${event.eventType}:`, encodeErr.message);
                            }

                            await this.producer.send({
                                topic: event.topic,
                                messages: [
                                    {
                                        key: event.key,
                                        value: encodedValue,
                                        headers: cleanHeaders,
                                    },
                                ],
                            });
                        } finally {
                            span.end();
                        }
                    }
                );

                const now = new Date();
                event.set({ publishedAt: now });
                await event.save();
                publishedCount++;

                try {
                    const lagSeconds = (now.getTime() - event.createdAt.getTime()) / 1000;
                    outboxPublishLagHistogram.observe({ service: this.serviceName }, Math.max(0, lagSeconds));
                } catch {}
            }

            return publishedCount;
        } finally {
            this.isPolling = false;
        }
    }
}
