import mongoose from "mongoose";
import { Ticket } from "../../../models/ticket";
import { PaymentCreatedListener } from "../payment-created-listener";
import { EventMetadata, OrderStatus, PaymentCreatedEvent, OutboxEvent, Subjects } from "@mehul-mrtickets/common";
import { Order } from "../../../models/order";

const setup = async (orderStatus = OrderStatus.Created) => {
    const listener = new PaymentCreatedListener();

    const ticket = Ticket.build({
        id: new mongoose.Types.ObjectId().toHexString(),
        title: "Concert",
        price: 20,
    });
    await ticket.save();

    const order = Order.build({
        userId: new mongoose.Types.ObjectId().toHexString(),
        status: orderStatus,
        ticket,
        expiresAt: new Date(),
    });
    await order.save();

    const paymentId = new mongoose.Types.ObjectId().toHexString();

    const data: PaymentCreatedEvent["data"] = {
        id: paymentId,
        orderId: order.id,
        stripeId: "stripe_charge_123",
    };

    const metadata: EventMetadata = {
        eventId: "test-event-id",
        occurredAt: new Date().toISOString(),
    };

    return {
        listener,
        ticket,
        data,
        order,
        metadata,
    };
};

describe("PaymentCreatedListener", () => {
    it("updates the order status to Complete when order is Created", async () => {
        const { listener, data, metadata } = await setup(OrderStatus.Created);
        await listener.onMessage(data, metadata);

        const updatedOrder = await Order.findById(data.orderId);
        expect(updatedOrder!.status).toEqual(OrderStatus.Complete);
    });

    it("publishes RefundRequested when order is already Cancelled (late payment race)", async () => {
        const { listener, data, metadata } = await setup(OrderStatus.Cancelled);
        await listener.onMessage(data, metadata);

        // Status must NOT transition to Complete
        const updatedOrder = await Order.findById(data.orderId);
        expect(updatedOrder!.status).toEqual(OrderStatus.Cancelled);

        // Outbox must contain RefundRequested event
        const outboxEvents = await OutboxEvent.find({ eventType: Subjects.RefundRequested });
        expect(outboxEvents.length).toEqual(1);
        expect(outboxEvents[0].key).toEqual(data.orderId);

        const payload = JSON.parse(outboxEvents[0].payload);
        expect(payload.orderId).toEqual(data.orderId);
        expect(payload.paymentId).toEqual(data.id);
    });

    it("is a no-op when order is already Complete (duplicate payment event)", async () => {
        const { listener, data, metadata } = await setup(OrderStatus.Complete);
        await listener.onMessage(data, metadata);

        const updatedOrder = await Order.findById(data.orderId);
        expect(updatedOrder!.status).toEqual(OrderStatus.Complete);

        const outboxEvents = await OutboxEvent.find({ eventType: Subjects.RefundRequested });
        expect(outboxEvents.length).toEqual(0);
    });
});
