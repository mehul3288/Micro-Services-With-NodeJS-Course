import { Producer } from "kafkajs";
import { randomUUID } from "crypto";
import { Subjects } from "./subjects";
import { topicFor } from "./topics";

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
        await this.producer.send({
            topic,
            messages: [
                {
                    key: this.partitionKey(data),
                    value: JSON.stringify(data),
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