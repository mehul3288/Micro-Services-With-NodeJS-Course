import { ClientSession } from "mongoose";
import { randomUUID } from "crypto";
import { Subjects } from "../events/subjects";
import { topicFor } from "../events/topics";
import { OutboxEvent, OutboxEventDoc } from "./outbox-event";

interface Event {
    subject: Subjects;
    data: any;
}

export abstract class OutboxPublisher<T extends Event> {
    abstract subject: T["subject"];
    abstract partitionKey(data: T["data"]): string;

    async publish(data: T["data"], session?: ClientSession): Promise<OutboxEventDoc> {
        const topic = topicFor[this.subject];
        const eventId = randomUUID();

        const outboxEvent = OutboxEvent.build({
            eventId,
            topic,
            key: this.partitionKey(data),
            eventType: this.subject,
            payload: JSON.stringify(data),
            headers: {
                "event-id": eventId,
                "event-type": this.subject,
                "occurred-at": new Date().toISOString(),
            },
        });

        await outboxEvent.save({ session });
        return outboxEvent;
    }
}
