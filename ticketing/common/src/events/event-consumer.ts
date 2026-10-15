import { Consumer, Kafka, KafkaMessage, Producer } from "kafkajs";
import { Listener } from "./base-listener";
import { Subjects } from "./subjects";
import { topicFor } from "./topics";

export class EventConsumer {
    private kafka: Kafka;
    private groupId: string;
    private consumer: Consumer;
    private dlqProducer: Producer;
    private listeners = new Map<Subjects, Listener<any>>();

    constructor(kafka: Kafka, groupId: string) {
        this.kafka = kafka;
        this.groupId = groupId;
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

                let data: any;
                try {
                    data = message.value ? JSON.parse(message.value.toString("utf-8")) : {};
                } catch (err: any) {
                    console.error(`Invalid JSON payload for ${eventType} on ${topic}:`, err);
                    await this.sendToDlq(topic, message, `JSON parse error: ${err.message}`);
                    return;
                }

                const maxAttempts = 3;
                let lastError: any;

                for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                    try {
                        await listener.onMessage(data, { eventId, occurredAt });
                        return; // Successfully processed
                    } catch (err: any) {
                        lastError = err;
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
                await this.sendToDlq(topic, message, lastError?.message || "Processing failed after retries");
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
