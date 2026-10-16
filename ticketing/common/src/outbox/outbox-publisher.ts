import { ClientSession } from "mongoose";
import { randomUUID } from "crypto";
import { context, propagation } from "@opentelemetry/api";
import { Subjects } from "../events/subjects";
import { topicFor } from "../events/topics";
import { OutboxEvent, OutboxEventDoc } from "./outbox-event";
import { eventsPublishedCounter } from "../metrics/metrics";

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

        const headers: Record<string, string> = {
            "event-id": eventId,
            "event-type": this.subject,
            "occurred-at": new Date().toISOString(),
        };

        // Capture active W3C trace context (traceparent) and inject into outbox record headers
        propagation.inject(context.active(), headers);

        const outboxEvent = OutboxEvent.build({
            eventId,
            topic,
            key: this.partitionKey(data),
            eventType: this.subject,
            payload: JSON.stringify(data),
            headers,
        });

        await outboxEvent.save({ session });

        // Record metrics
        try {
            eventsPublishedCounter.inc({ topic, event_type: this.subject });
        } catch {}

        return outboxEvent;
    }
}
