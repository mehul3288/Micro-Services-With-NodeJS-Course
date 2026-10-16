import mongoose from "mongoose";
import { Ticket } from "../../../models/ticket";
import { kafkaWrapper } from "../../../kafka-wrapper";
import { ExpirationCompleteListener } from "../expiration-complete-listener";
import { EventMetadata, ExpirationCompleteEvent, OrderStatus } from "@mehul-mrtickets/common";
import { Order } from "../../../models/order";

const setup = async () => {
    const listener = new ExpirationCompleteListener();

    const ticket = Ticket.build({
        id: new mongoose.Types.ObjectId().toHexString(),
        title: "Concert",
        price: 20,
    });
    await ticket.save();

    const order = Order.build({
        userId: new mongoose.Types.ObjectId().toHexString(),
        status: OrderStatus.Created,
        ticket,
        expiresAt: new Date(),
    });
    await order.save();

    // Reserve ticket
    await Ticket.reserve(ticket.id, order.id);

    const data: ExpirationCompleteEvent["data"] = {
        orderId: order.id,
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

it("updates the order status to cancelled and releases the ticket", async () => {
    const { listener, data, ticket, metadata } = await setup();
    await listener.onMessage(data, metadata);

    const updatedOrder = await Order.findById(data.orderId);
    expect(updatedOrder!.status).toEqual(OrderStatus.Cancelled);

    const updatedTicket = await Ticket.findById(ticket.id);
    expect(updatedTicket?.reservedBy).toBeNull();
});

import { OutboxEvent, Subjects } from "@mehul-mrtickets/common";

it("writes an orderCancelled outbox event with ticket.id partition key", async () => {
    const { listener, data, order, ticket, metadata } = await setup();
    await listener.onMessage(data, metadata);

    const outboxEvents = await OutboxEvent.find({ eventType: Subjects.OrderCancelled });
    expect(outboxEvents.length).toEqual(1);
    expect(outboxEvents[0].key).toEqual(ticket.id);

    const payload = JSON.parse(outboxEvents[0].payload);
    expect(payload.id).toEqual(order.id);
});