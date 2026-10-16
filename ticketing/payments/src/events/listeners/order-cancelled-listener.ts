import { EventMetadata, Listener, OrderCancelledEvent, OrderStatus, Subjects } from "@mehul-mrtickets/common";
import { Order } from "../../models/order";

export class OrderCancelledListener extends Listener<OrderCancelledEvent> {
    subject: Subjects.OrderCancelled = Subjects.OrderCancelled;

    async onMessage(data: OrderCancelledEvent["data"], metadata: EventMetadata): Promise<void> {
        const order = await Order.findOne({
            _id: data.id,
            version: data.version - 1,
        }).session(metadata.session || null);
        if (!order) {
            throw new Error("Order not found");
        }

        order.set({
            status: OrderStatus.Cancelled,
        });
        await order.save({ session: metadata.session });
    }
}