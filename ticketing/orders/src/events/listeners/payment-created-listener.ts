import { EventMetadata, Listener, OrderStatus, PaymentCreatedEvent, Subjects } from "@mehul-mrtickets/common";
import { Order } from "../../models/order";

export class PaymentCreatedListener extends Listener<PaymentCreatedEvent> {
    readonly subject: Subjects.PaymentCreated = Subjects.PaymentCreated;

    async onMessage(data: PaymentCreatedEvent["data"], metadata: EventMetadata): Promise<void> {
        const order = await Order.findById(data.orderId);
        if (!order) {
            throw new Error("Order not found");
        }
        order.set({
            status: OrderStatus.Complete,
        });
        await order.save();
    }
}