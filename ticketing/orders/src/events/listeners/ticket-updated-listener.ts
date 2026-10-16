import { EventMetadata, Listener, Subjects, TicketUpdateEvent } from "@mehul-mrtickets/common";
import { Ticket } from "../../models/ticket";

export class TicketUpdatedListener extends Listener<TicketUpdateEvent> {
    subject: Subjects.TicketUpdated = Subjects.TicketUpdated;

    async onMessage(data: TicketUpdateEvent["data"], metadata: EventMetadata): Promise<void> {
        const ticket = await Ticket.findByEvent(data, metadata.session);
        if (!ticket) {
            throw new Error("Ticket not found");
        }
        ticket.set({
            title: data.title,
            price: data.price,
        });
        await ticket.save({ session: metadata.session });
    }
}