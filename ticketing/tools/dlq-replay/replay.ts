import { Kafka } from "kafkajs";

const brokers = (process.env.KAFKA_BROKERS || "localhost:9092").split(",");
const topic = process.argv[2];

if (!topic) {
    console.error("Usage: ts-node replay.ts <topic-name>");
    console.error("Example: ts-node replay.ts ticket-events");
    process.exit(1);
}

const dlqTopic = topic.endsWith(".dlq") ? topic : `${topic}.dlq`;
const targetTopic = topic.endsWith(".dlq") ? topic.replace(".dlq", "") : topic;

async function replay() {
    const kafka = new Kafka({ clientId: "dlq-replay-tool", brokers });
    const consumer = kafka.consumer({ groupId: `dlq-replay-${Date.now()}` });
    const producer = kafka.producer();

    await consumer.connect();
    await producer.connect();
    await consumer.subscribe({ topic: dlqTopic, fromBeginning: true });

    console.log(`Starting replay from ${dlqTopic} -> ${targetTopic}...`);

    let replayedCount = 0;

    await consumer.run({
        eachMessage: async ({ message }) => {
            const cleanHeaders: Record<string, string> = {};
            if (message.headers) {
                for (const [key, val] of Object.entries(message.headers)) {
                    if (!key.startsWith("dlq-") && val) {
                        cleanHeaders[key] = val.toString();
                    }
                }
            }

            await producer.send({
                topic: targetTopic,
                messages: [
                    {
                        key: message.key,
                        value: message.value,
                        headers: cleanHeaders,
                    },
                ],
            });

            replayedCount++;
            console.log(`[${replayedCount}] Replayed key=${message.key?.toString()} to ${targetTopic}`);
        },
    });
}

replay().catch((err) => {
    console.error("DLQ Replay failed:", err);
    process.exit(1);
});
