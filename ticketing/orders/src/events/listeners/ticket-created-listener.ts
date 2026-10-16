import { EventMetadata, Listener, Subjects, TicketCreatedEvent } from "@mehul-mrtickets/common";
import { Ticket } from "../../models/ticket";

export class TicketCreatedListener extends Listener<TicketCreatedEvent> {
    subject: Subjects.TicketCreated = Subjects.TicketCreated;

    async onMessage(data: TicketCreatedEvent["data"], metadata: EventMetadata): Promise<void> {
        const ticket = Ticket.build({
            id: data.id,
            title: data.title,
            price: data.price,
        });

        await ticket.save({ session: metadata.session });
    }
}