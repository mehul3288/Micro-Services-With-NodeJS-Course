import { EventMetadata, Listener, OrderCancelledEvent, Subjects } from "@mehul-mrtickets/common";
import { Ticket } from "../../models/ticket";
import { TicketUpdatedPublisher } from "../publishers/ticket-updated-publisher";
import { ticketCache } from "../../services/ticket-cache";
import { toTicketUpdatedEvent } from "../builders/ticket-event-builders";

export class OrderCancelledListener extends Listener<OrderCancelledEvent> {
    subject: Subjects.OrderCancelled = Subjects.OrderCancelled;

    async onMessage(data: OrderCancelledEvent["data"], metadata: EventMetadata): Promise<void> {
        const ticket = await Ticket.findById(data.ticket.id).session(metadata.session || null);

        if (!ticket) {
            throw new Error("Ticket not found");
        }

        // Defensive check: only release if this order actually holds the reservation
        if (ticket.orderId !== data.id) {
            console.warn(
                `OrderCancelledListener: Ticket ${ticket.id} orderId (${ticket.orderId}) does not match cancelling order ${data.id}. Skipping release.`
            );
            return;
        }

        ticket.set({ orderId: undefined });
        await ticket.save({ session: metadata.session });

        await new TicketUpdatedPublisher().publish(
            toTicketUpdatedEvent(ticket),
            metadata.session
        );

        // Invalidate cached ticket and catalog list so released ticket reappears in browse
        await ticketCache.invalidate(ticket.id);
    }
}