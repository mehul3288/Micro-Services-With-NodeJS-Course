import { EventMetadata, OrderCancelledEvent, OrderStatus } from "@mehul-mrtickets/common";
import { Order } from "../../../models/order";
import { OrderCancelledListener } from "../order-cancelled-listener";
import mongoose from "mongoose";

const setup = async () => {
    const listener = new OrderCancelledListener();

    const order = Order.build({
        id: new mongoose.Types.ObjectId().toHexString(),
        version: 0,
        userId: new mongoose.Types.ObjectId().toHexString(),
        price: 20,
        status: OrderStatus.Created,
        expiresAt: new Date(Date.now() + 60000),
    });

    await order.save();

    const data: OrderCancelledEvent["data"] = {
        id: order._id.toHexString(),
        version: 1,
        ticket: {
            id: new mongoose.Types.ObjectId().toHexString(),
        },
    };

    const metadata: EventMetadata = {
        eventId: "test-event-id",
        occurredAt: new Date().toISOString(),
    };

    return { listener, data, metadata, order };
};

it("marks the order as cancelled", async () => {
    const { listener, data, order, metadata } = await setup();

    await listener.onMessage(data, metadata);

    const updatedOrder = await Order.findById(order._id.toHexString());

    expect(updatedOrder).toBeDefined();
    expect(updatedOrder!.status).toEqual(OrderStatus.Cancelled);
});

it("resolves without error upon successful processing", async () => {
    const { listener, data, metadata } = await setup();

    await expect(listener.onMessage(data, metadata)).resolves.not.toThrow();
});