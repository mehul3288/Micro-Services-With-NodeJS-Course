import { EventMetadata, OrderCancelledEvent } from "@mehul-mrtickets/common";
import { kafkaWrapper } from "../../../kafka-wrapper";
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

it("updates the ticket, removing its orderId and publishes an event", async () => {
    const { data, ticket, listener, metadata } = await setup();
    await listener.onMessage(data, metadata);

    const updatedTicket = await Ticket.findById(ticket.id);
    expect(updatedTicket!.orderId).not.toBeDefined();

    expect(kafkaWrapper.producer.send).toHaveBeenCalled();
    const sendCall = (kafkaWrapper.producer.send as jest.Mock).mock.calls[0][0];
    expect(sendCall.messages[0].key).toEqual(ticket.id);
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
    expect(kafkaWrapper.producer.send).not.toHaveBeenCalled();
});