import { OutboxPublisher, Subjects, TicketUpdateEvent } from "@mehul-mrtickets/common";

export class TicketUpdatedPublisher extends OutboxPublisher<TicketUpdateEvent> {
    readonly subject = Subjects.TicketUpdated;
    partitionKey(data: TicketUpdateEvent["data"]): string {
        return data.id;
    }
}