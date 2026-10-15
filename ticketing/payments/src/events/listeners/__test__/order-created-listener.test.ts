import { EventMetadata, OrderCreatedEvent, OrderStatus } from "@mehul-mrtickets/common";
import { Order } from "../../../models/order";
import { OrderCreatedListener } from "../order-created-listener";
import mongoose from "mongoose";

const setup = async () => {
    const listener = new OrderCreatedListener();

    const data: OrderCreatedEvent["data"] = {
        id: new mongoose.Types.ObjectId().toHexString(),
        version: 0,
        userId: new mongoose.Types.ObjectId().toHexString(),
        status: OrderStatus.Created,
        expiresAt: new Date().toISOString(),
        ticket: {
            id: new mongoose.Types.ObjectId().toHexString(),
            price: 20,
        },
    };

    const metadata: EventMetadata = {
        eventId: "test-event-id",
        occurredAt: new Date().toISOString(),
    };

    return { listener, data, metadata };
};

it("replicates the order", async () => {
    const { listener, data, metadata } = await setup();

    await listener.onMessage(data, metadata);

    const order = await Order.findById(data.id);

    expect(order).toBeDefined();
    expect(order!.version).toEqual(data.version);
    expect(order!.price).toEqual(data.ticket.price);
    expect(order!.userId).toEqual(data.userId);
    expect(order!.status).toEqual(data.status);
});

it("resolves without error upon successful processing", async () => {
    const { listener, data, metadata } = await setup();

    await expect(listener.onMessage(data, metadata)).resolves.not.toThrow();
});