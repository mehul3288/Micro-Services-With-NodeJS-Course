import { EventMetadata, OrderCancelledEvent, OutboxEvent } from "@mehul-mrtickets/common";
import mongoose from "mongoose";
import { OrderCancelledListener } from "../order-cancelled-listener";
import { Ticket } from "../../../models/ticket";

const setup = async () => {
    const listener = new OrderCancelledListener();
    const orderId = new mongoose.Types.ObjectId().toHexString();

    const ticket = Ticket.build({
        title: "concert",
        price: 20,
        userId: "abc",
    });
    ticket.set({ orderId });
    await ticket.save();

    const data: OrderCancelledEvent["data"] = {
        id: orderId,
        version: 1,
        ticket: {
            id: ticket.id,
        },
    };

    const metadata: EventMetadata = {
        eventId: "test-event-id",
        occurredAt: new Date().toISOString(),
    };

    return { data, ticket, listener, orderId, metadata };
};

it("updates the ticket, removing its orderId and writes an outbox event", async () => {
    const { data, ticket, listener, metadata } = await setup();
    await listener.onMessage(data, metadata);

    const updatedTicket = await Ticket.findById(ticket.id);
    expect(updatedTicket!.orderId).not.toBeDefined();

    const outboxEvents = await OutboxEvent.find({ eventType: "ticket:updated" });
    expect(outboxEvents.length).toEqual(1);
    expect(outboxEvents[0].key).toEqual(ticket.id);
});

it("does not clear orderId if cancelling order id does not match ticket orderId", async () => {
    const { ticket, listener, metadata } = await setup();

    const differentOrderData: OrderCancelledEvent["data"] = {
        id: new mongoose.Types.ObjectId().toHexString(), // different order
        version: 1,
        ticket: {
            id: ticket.id,
        },
    };

    await listener.onMessage(differentOrderData, metadata);

    const updatedTicket = await Ticket.findById(ticket.id);
    expect(updatedTicket!.orderId).toBeDefined();

    const outboxEvents = await OutboxEvent.find({ eventType: "ticket:updated" });
    expect(outboxEvents.length).toEqual(0);
});