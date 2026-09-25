import { Publisher, Subjects, TicketUpdateEvent } from "@mehul-mrtickets/common";

export class TicketUpdatedPublisher extends Publisher<TicketUpdateEvent> {
    readonly subject = Subjects.TicketUpdated;
}