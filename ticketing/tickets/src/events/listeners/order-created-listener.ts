import { EventMetadata, Listener, OrderCreatedEvent, Subjects } from "@mehul-mrtickets/common";
import { Ticket } from "../../models/ticket";
import { TicketUpdatedPublisher } from "../publishers/ticket-updated-publisher";
import { ticketCache } from "../../services/ticket-cache";
import { toTicketUpdatedEvent } from "../builders/ticket-event-builders";

export class OrderCreatedListener extends Listener<OrderCreatedEvent> {
    subject: Subjects.OrderCreated = Subjects.OrderCreated;

    async onMessage(data: OrderCreatedEvent["data"], metadata: EventMetadata): Promise<void> {
        const ticket = await Ticket.findById(data.ticket.id).session(metadata.session || null);

        if (!ticket) {
            throw new Error("Ticket not found");
        }

        ticket.set({ orderId: data.id });
        await ticket.save({ session: metadata.session });

        await new TicketUpdatedPublisher().publish(
            toTicketUpdatedEvent(ticket),
            metadata.session
        );

        // Invalidate cached ticket and catalog list so reserved ticket is removed from browse
        await ticketCache.invalidate(ticket.id);
    }
}