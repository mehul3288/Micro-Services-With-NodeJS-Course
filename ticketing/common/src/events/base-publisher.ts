import { Producer } from "kafkajs";
import { randomUUID } from "crypto";
import { Subjects } from "./subjects";
import { topicFor } from "./topics";
import { schemaRegistry } from "./schema-registry";

interface Event {
    subject: Subjects;
    data: any;
}

export abstract class Publisher<T extends Event> {
    abstract subject: T["subject"];
    abstract partitionKey(data: T["data"]): string;
    protected producer: Producer;

    constructor(producer: Producer) {
        this.producer = producer;
    }

    async publish(data: T["data"]): Promise<void> {
        const topic = topicFor[this.subject];
        let encodedValue: Buffer | string;
        try {
            encodedValue = await schemaRegistry.encode(topic, this.subject, data);
        } catch {
            encodedValue = JSON.stringify(data);
        }

        await this.producer.send({
            topic,
            messages: [
                {
                    key: this.partitionKey(data),
                    value: encodedValue,
                    headers: {
                        "event-id": randomUUID(),
                        "event-type": this.subject,
                        "occurred-at": new Date().toISOString(),
                    },
                },
            ],
        });
        console.log(`Event published to topic ${topic} [${this.subject}]`);
    }
}