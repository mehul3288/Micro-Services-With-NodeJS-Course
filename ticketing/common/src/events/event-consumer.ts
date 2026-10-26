import { Consumer, Kafka, KafkaMessage, Producer } from "kafkajs";
import { Connection } from "mongoose";
import { context, propagation, ROOT_CONTEXT, trace, SpanKind } from "@opentelemetry/api";
import { Listener } from "./base-listener";
import { Subjects } from "./subjects";
import { topicFor } from "./topics";
import { ProcessedEvent } from "./processed-event";
import { eventsConsumedCounter } from "../metrics/metrics";
import { schemaRegistry } from "./schema-registry";

export interface EventConsumerOptions {
    deduplicate?: boolean;
    connection?: Connection;
}

export class EventConsumer {
    private kafka: Kafka;
    private groupId: string;
    private consumer: Consumer;
    private dlqProducer: Producer;
    private options?: EventConsumerOptions;
    private listeners = new Map<Subjects, Listener<any>>();

    constructor(kafka: Kafka, groupId: string, options?: EventConsumerOptions) {
        this.kafka = kafka;
        this.groupId = groupId;
        this.options = options;
        this.consumer = this.kafka.consumer({ groupId: this.groupId });
        this.dlqProducer = this.kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
    }

    register(listener: Listener<any>): this {
        this.listeners.set(listener.subject, listener);
        return this;
    }

    async start(): Promise<void> {
        await this.consumer.connect();
        await this.dlqProducer.connect();

        const topicsToSubscribe = new Set<string>();
        for (const subject of this.listeners.keys()) {
            const topic = topicFor[subject];
            if (topic) {
                topicsToSubscribe.add(topic);
            }
        }

        for (const topic of topicsToSubscribe) {
            await this.consumer.subscribe({ topic, fromBeginning: false });
            console.log(`Subscribed consumer [${this.groupId}] to topic: ${topic}`);
        }

        await this.consumer.run({
            eachMessage: async ({ topic, partition, message, heartbeat }) => {
                const eventType = message.headers?.["event-type"]?.toString() as Subjects | undefined;
                const eventId = message.headers?.["event-id"]?.toString() || "";
                const occurredAt = message.headers?.["occurred-at"]?.toString() || new Date().toISOString();

                if (!eventType || !this.listeners.has(eventType)) {
                    // This service is not registered for this event type
                    return;
                }

                const listener = this.listeners.get(eventType)!;

                // Extract incoming W3C trace context from Kafka headers
                const rawHeaders = message.headers || {};
                const stringHeaders: Record<string, string> = {};
                for (const [k, v] of Object.entries(rawHeaders)) {
                    if (v !== undefined && v !== null) {
                        stringHeaders[k] = v.toString();
                    }
                }
                const extractedContext = propagation.extract(ROOT_CONTEXT, stringHeaders);
                const tracer = trace.getTracer("@mehul-mrtickets/common");

                await tracer.startActiveSpan(
                    `consume: ${eventType}`,
                    {
                        kind: SpanKind.CONSUMER,
                        attributes: {
                            "messaging.system": "kafka",
                            "messaging.destination": topic,
                            "messaging.operation": "process",
                            "messaging.event_type": eventType,
                            "messaging.event_id": eventId || "",
                            "messaging.consumer_group": this.groupId,
                        },
                    },
                    extractedContext,
                    async (span) => {
                        try {
                            let data: any;
                            try {
                                if (message.value) {
                                    data = await schemaRegistry.decode(topic, eventType, message.value);
                                } else {
                                    data = {};
                                }
                            } catch (err: any) {
                                console.error(`Schema validation or decode error for ${eventType} on ${topic}:`, err.message);
                                try {
                                    eventsConsumedCounter.inc({ topic, event_type: eventType, result: "dlq" });
                                } catch {}
                                await this.sendToDlq(topic, message, `Schema validation error: ${err.message}`);
                                return;
                            }

                            // Deduplication fast-path check
                            if (this.options?.deduplicate && eventId) {
                                const alreadyProcessed = await ProcessedEvent.findOne({
                                    eventId,
                                    consumerGroup: this.groupId,
                                });
                                if (alreadyProcessed) {
                                    console.log(`[${this.groupId}] Duplicate event ${eventId} (${eventType}) already processed. Skipping.`);
                                    try {
                                        eventsConsumedCounter.inc({ topic, event_type: eventType, result: "duplicate" });
                                    } catch {}
                                    return;
                                }
                            }

                            const maxAttempts = 3;
                            let lastError: any;

                            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                                try {
                                    if (this.options?.deduplicate && this.options?.connection && eventId) {
                                        // Execute inside a MongoDB transaction with atomic deduplication
                                        await this.options.connection.transaction(async (session) => {
                                            await ProcessedEvent.create(
                                                [{ eventId, consumerGroup: this.groupId, processedAt: new Date() }],
                                                { session }
                                            );
                                            await listener.onMessage(data, { eventId, occurredAt, session });
                                        });
                                    } else {
                                        await listener.onMessage(data, { eventId, occurredAt });
                                    }

                                    try {
                                        eventsConsumedCounter.inc({ topic, event_type: eventType, result: "ok" });
                                    } catch {}
                                    return; // Successfully processed
                                } catch (err: any) {
                                    // If duplicate key error occurred concurrently, skip safely
                                    if (err.code === 11000 || (err.message && err.message.includes("E11000"))) {
                                        console.log(`[${this.groupId}] Concurrent duplicate event ${eventId} (${eventType}) detected. Skipping.`);
                                        try {
                                            eventsConsumedCounter.inc({ topic, event_type: eventType, result: "duplicate" });
                                        } catch {}
                                        return;
                                    }

                                    lastError = err;
                                    try {
                                        eventsConsumedCounter.inc({ topic, event_type: eventType, result: "retry" });
                                    } catch {}

                                    console.error(
                                        `[${this.groupId}] Attempt ${attempt}/${maxAttempts} failed for ${eventType} on ${topic} (partition ${partition}):`,
                                        err.message
                                    );

                                    if (attempt < maxAttempts) {
                                        await heartbeat();
                                        const delayMs = attempt * 1000; // 1s, 2s
                                        await new Promise((resolve) => setTimeout(resolve, delayMs));
                                        await heartbeat();
                                    }
                                }
                            }

                            console.error(
                                `[${this.groupId}] All ${maxAttempts} attempts exhausted for ${eventType} on ${topic}. Sending to DLQ.`
                            );
                            try {
                                eventsConsumedCounter.inc({ topic, event_type: eventType, result: "dlq" });
                            } catch {}
                            await this.sendToDlq(topic, message, lastError?.message || "Processing failed after retries");
                        } finally {
                            span.end();
                        }
                    }
                );
            },
        });
    }

    private async sendToDlq(originalTopic: string, message: KafkaMessage, errorMsg: string): Promise<void> {
        const dlqTopic = `${originalTopic}.dlq`;
        try {
            await this.dlqProducer.send({
                topic: dlqTopic,
                messages: [
                    {
                        key: message.key,
                        value: message.value,
                        headers: {
                            ...message.headers,
                            "dlq-error": errorMsg,
                            "dlq-consumer-group": this.groupId,
                            "dlq-original-topic": originalTopic,
                            "dlq-failed-at": new Date().toISOString(),
                        },
                    },
                ],
            });
            console.log(`Forwarded message to DLQ [${dlqTopic}] for consumer group [${this.groupId}]`);
        } catch (dlqErr) {
            console.error(`Critical: Failed to publish message to DLQ ${dlqTopic}:`, dlqErr);
            throw dlqErr;
        }
    }

    async disconnect(): Promise<void> {
        try {
            await this.consumer.disconnect();
            await this.dlqProducer.disconnect();
            console.log(`Disconnected consumer [${this.groupId}] and DLQ producer.`);
        } catch (err) {
            console.error(`Error disconnecting consumer [${this.groupId}]:`, err);
        }
    }
}
