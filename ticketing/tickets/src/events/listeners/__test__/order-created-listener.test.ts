import { EventMetadata, OrderCreatedEvent, OrderStatus, OutboxEvent } from "@mehul-mrtickets/common";
import { Ticket } from "../../../models/ticket";
import { OrderCreatedListener } from "../order-created-listener";
import mongoose from "mongoose";

const setup = async () => {
    const listener = new OrderCreatedListener();

    const ticket = Ticket.build({
        title: "concert",
        price: 99,
        userId: "wsd",
    });
    await ticket.save();

    const data: OrderCreatedEvent["data"] = {
        id: new mongoose.Types.ObjectId().toHexString(),
        version: 0,
        status: OrderStatus.Created,
        userId: new mongoose.Types.ObjectId().toHexString(),
        expiresAt: "2025-10-01T12:00:00.000Z",
        ticket: {
            id: ticket.id,
            price: ticket.price,
        },
    };

    const metadata: EventMetadata = {
        eventId: "test-event-id",
        occurredAt: new Date().toISOString(),
    };

    return { listener, ticket, data, metadata };
};

it("reserves the ticket", async () => {
    const { listener, ticket, data, metadata } = await setup();

    await listener.onMessage(data, metadata);

    const updatedTicket = await Ticket.findById(ticket.id);

    expect(updatedTicket).toBeDefined();
    expect(updatedTicket?.orderId).toEqual(data.id);
});

it("writes a ticket updated outbox event with partition key", async () => {
    const { listener, ticket, data, metadata } = await setup();

    await listener.onMessage(data, metadata);

    const outboxEvents = await OutboxEvent.find({ eventType: "ticket:updated" });
    expect(outboxEvents.length).toEqual(1);
    expect(outboxEvents[0].topic).toEqual("ticket-events");
    expect(outboxEvents[0].key).toEqual(ticket.id);

    const ticketUpdated = JSON.parse(outboxEvents[0].payload);
    expect(ticketUpdated.orderId).toEqual(data.id);
});
