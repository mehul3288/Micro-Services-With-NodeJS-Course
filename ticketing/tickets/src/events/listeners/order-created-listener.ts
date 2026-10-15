import { EventMetadata, Listener, OrderCreatedEvent, Subjects } from "@mehul-mrtickets/common";
import { Ticket } from "../../models/ticket";
import { TicketUpdatedPublisher } from "../publishers/ticket-updated-publisher";
import { kafkaWrapper } from "../../kafka-wrapper";

export class OrderCreatedListener extends Listener<OrderCreatedEvent> {
    subject: Subjects.OrderCreated = Subjects.OrderCreated;

    async onMessage(data: OrderCreatedEvent["data"], metadata: EventMetadata): Promise<void> {
        const ticket = await Ticket.findById(data.ticket.id);

        if (!ticket) {
            throw new Error("Ticket not found");
        }

        ticket.set({ orderId: data.id });
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