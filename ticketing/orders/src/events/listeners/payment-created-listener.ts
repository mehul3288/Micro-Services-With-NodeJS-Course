import { EventMetadata, Listener, OrderStatus, PaymentCreatedEvent, Subjects } from "@mehul-mrtickets/common";
import { Order } from "../../models/order";
import { canTransition } from "../../models/order-transitions";
import { RefundRequestedPublisher } from "../publishers/refund-requested-publisher";
import { toRefundRequestedEvent } from "../builders/order-event-builders";

export class PaymentCreatedListener extends Listener<PaymentCreatedEvent> {
    readonly subject: Subjects.PaymentCreated = Subjects.PaymentCreated;

    async onMessage(data: PaymentCreatedEvent["data"], metadata: EventMetadata): Promise<void> {
        const order = await Order.findById(data.orderId).session(metadata.session || null);
        if (!order) {
            throw new Error("Order not found");
        }

        // Late payment race: order expired or was cancelled before payment completed
        if (order.status === OrderStatus.Cancelled) {
            await new RefundRequestedPublisher().publish(
                toRefundRequestedEvent(
                    order.id,
                    data.id,
                    "Order expired or was cancelled before payment completed"
                ),
                metadata.session
            );
            return;
        }

        if (!canTransition(order.status, OrderStatus.Complete)) {
            return;
        }

        order.set({
            status: OrderStatus.Complete,
        });
        await order.save({ session: metadata.session });
    }
}