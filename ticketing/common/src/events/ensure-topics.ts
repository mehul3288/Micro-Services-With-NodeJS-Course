import { Kafka } from "kafkajs";
import { Topics } from "./topics";

export async function ensureTopics(kafka: Kafka, topics?: string[]): Promise<void> {
    const admin = kafka.admin();
    await admin.connect();

    try {
        const topicsToEnsure = topics || Object.values(Topics);
        const existingTopics = await admin.listTopics();

        const topicConfigs: { topic: string; numPartitions: number; replicationFactor: number }[] = [];

        for (const topic of topicsToEnsure) {
            if (!existingTopics.includes(topic)) {
                topicConfigs.push({
                    topic,
                    numPartitions: 3,
                    replicationFactor: 1,
                });
            }
            const dlqTopic = `${topic}.dlq`;
            if (!existingTopics.includes(dlqTopic)) {
                topicConfigs.push({
                    topic: dlqTopic,
                    numPartitions: 3,
                    replicationFactor: 1,
                });
            }
        }

        if (topicConfigs.length > 0) {
            await admin.createTopics({
                topics: topicConfigs,
                waitForLeaders: true,
            });
            console.log(`Kafka topics verified/created: ${topicConfigs.map((t) => t.topic).join(", ")}`);
        }
    } finally {
        await admin.disconnect();
    }
}
