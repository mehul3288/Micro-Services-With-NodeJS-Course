import { EventMetadata, ExpirationCompleteEvent, Listener, OrderStatus, Subjects } from "@mehul-mrtickets/common";
import { Order } from "../../models/order";
import { Ticket } from "../../models/ticket";
import { OrderCancelledPublisher } from "../publishers/order-cancelled-publisher";

export class ExpirationCompleteListener extends Listener<ExpirationCompleteEvent> {
    subject: Subjects.ExpirationComplete = Subjects.ExpirationComplete;

    async onMessage(data: ExpirationCompleteEvent["data"], metadata: EventMetadata): Promise<void> {
        const order = await Order.findById(data.orderId).populate("ticket").session(metadata.session || null);

        if (!order) {
            throw new Error("Order not found");
        }

        if (order.status === OrderStatus.Cancelled || order.status === OrderStatus.Complete) {
            return;
        }

        // Release atomic ticket reservation upon order expiration
        await Ticket.release(order.ticket.id, order.id, metadata.session);

        order.set({
            status: OrderStatus.Cancelled,
        });

        await order.save({ session: metadata.session });

        await new OrderCancelledPublisher().publish({
            id: order.id,
            version: order.version,
            ticket: {
                id: order.ticket.id,
            },
        }, metadata.session);
    }
}