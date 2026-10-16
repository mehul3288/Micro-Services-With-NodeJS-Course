import { Producer } from "kafkajs";
import { randomUUID } from "crypto";
import { OutboxEvent } from "./outbox-event";
import { acquireLease } from "./lease";

export interface OutboxRelayOptions {
    pollIntervalMs?: number;
    leaseName?: string;
    holderId?: string;
    batchSize?: number;
}

export class OutboxRelay {
    private producer: Producer;
    private pollIntervalMs: number;
    private leaseName: string;
    private holderId: string;
    private batchSize: number;
    private isRunning = false;
    private timer?: NodeJS.Timeout;
    private isPolling = false;

    constructor(producer: Producer, options?: OutboxRelayOptions) {
        this.producer = producer;
        this.pollIntervalMs = options?.pollIntervalMs || 200;
        this.leaseName = options?.leaseName || "outbox-relay-lease";
        this.holderId = options?.holderId || process.env.HOSTNAME || randomUUID();
        this.batchSize = options?.batchSize || 100;
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

                await this.producer.send({
                    topic: event.topic,
                    messages: [
                        {
                            key: event.key,
                            value: event.payload,
                            headers: cleanHeaders,
                        },
                    ],
                });

                event.set({ publishedAt: new Date() });
                await event.save();
                publishedCount++;
            }

            return publishedCount;
        } finally {
            this.isPolling = false;
        }
    }
}
