import { Publisher, Subjects, TicketCreatedEvent } from "@mehul-mrtickets/common";

export class TicketCreatedPublisher extends Publisher<TicketCreatedEvent> {
    readonly subject = Subjects.TicketCreated;
    partitionKey(data: TicketCreatedEvent["data"]): string {
        return data.id;
    }
}