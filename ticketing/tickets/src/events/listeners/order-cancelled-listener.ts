import { EventMetadata, Listener, OrderCancelledEvent, Subjects } from "@mehul-mrtickets/common";
import { Ticket } from "../../models/ticket";
import { TicketUpdatedPublisher } from "../publishers/ticket-updated-publisher";
import { kafkaWrapper } from "../../kafka-wrapper";

export class OrderCancelledListener extends Listener<OrderCancelledEvent> {
    subject: Subjects.OrderCancelled = Subjects.OrderCancelled;

    async onMessage(data: OrderCancelledEvent["data"], metadata: EventMetadata): Promise<void> {
        const ticket = await Ticket.findById(data.ticket.id);

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
        await ticket.save();

        await new TicketUpdatedPublisher(kafkaWrapper.producer).publish({
            id: ticket.id,
            version: ticket.version,
            title: ticket.title,
            price: ticket.price,
            userId: ticket.userId,
            orderId: ticket.orderId,
        });
    }
}