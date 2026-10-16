import { EventMetadata, ExpirationCompleteEvent, Listener, Subjects } from "@mehul-mrtickets/common";
import { Order } from "../../models/order";
import { cancelOrder } from "../../services/cancel-order";

export class ExpirationCompleteListener extends Listener<ExpirationCompleteEvent> {
    subject: Subjects.ExpirationComplete = Subjects.ExpirationComplete;

    async onMessage(data: ExpirationCompleteEvent["data"], metadata: EventMetadata): Promise<void> {
        const order = await Order.findById(data.orderId).populate("ticket").session(metadata.session || null);

        if (!order) {
            throw new Error("Order not found");
        }

        await cancelOrder(order, metadata.session);
    }
}