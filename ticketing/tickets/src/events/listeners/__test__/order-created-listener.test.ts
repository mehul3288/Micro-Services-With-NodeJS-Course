import { EventMetadata, OrderCreatedEvent, OrderStatus } from "@mehul-mrtickets/common";
import { Ticket } from "../../../models/ticket";
import { kafkaWrapper } from "../../../kafka-wrapper";
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

it("publishes a ticket updated event with partition key", async () => {
    const { listener, ticket, data, metadata } = await setup();

    await listener.onMessage(data, metadata);

    expect(kafkaWrapper.producer.send).toHaveBeenCalled();

    const sendCall = (kafkaWrapper.producer.send as jest.Mock).mock.calls[0][0];
    const message = sendCall.messages[0];
    const ticketUpdated = JSON.parse(message.value);

    expect(ticketUpdated.orderId).toEqual(data.id);
    expect(message.key).toEqual(ticket.id);
});
