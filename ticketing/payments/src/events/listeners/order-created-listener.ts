import { EventMetadata, Listener, OrderCreatedEvent, Subjects } from "@mehul-mrtickets/common";
import { Order } from "../../models/order";

export class OrderCreatedListener extends Listener<OrderCreatedEvent> {
    subject: Subjects.OrderCreated = Subjects.OrderCreated;

    async onMessage(data: OrderCreatedEvent["data"], metadata: EventMetadata): Promise<void> {
        const { id, version, userId, ticket, status } = data;

        const order = Order.build({
            id,
            version,
            userId,
            price: ticket.price,
            status,
        });

        await order.save();
    }
}