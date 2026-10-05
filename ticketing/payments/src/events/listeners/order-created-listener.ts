import { Listener, OrderCreatedEvent, OrderStatus, Subjects } from "@mehul-mrtickets/common";
import { Message } from "node-nats-streaming";
import { queueGroupName } from "./queue-group-name";
import { Order } from "../../models/order";

export class OrderCreatedListener extends Listener<OrderCreatedEvent> {
    subject: Subjects.OrderCreated = Subjects.OrderCreated;
    queueGroupName = queueGroupName

    async onMessage(data: OrderCreatedEvent["data"], msg: Message) {
        const { id, version, userId, ticket, status } = data;

        const order = Order.build({
            id,
            version,
            userId,
            price: ticket.price,
            status
        })

        await order.save();
        msg.ack();
    }
}