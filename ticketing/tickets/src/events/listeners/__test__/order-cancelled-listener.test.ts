import { OrderCancelledEvent } from "@mehul-mrtickets/common";

import { natsWrapper } from "../../../nats-wrapper";
import mongoose from "mongoose";
import { Message } from "node-nats-streaming";
import { OrderCancelledListener } from "../order-cancelled-listener";
import { Ticket } from "../../../models/ticket";

const setup = async () => {
    const listener = new OrderCancelledListener(natsWrapper.client);
    const ticket = Ticket.build({
        title: "concert",
        price: 20,
        userId: "abc"
    });
    ticket.set({ orderId: new mongoose.Types.ObjectId().toHexString() })
    await ticket.save();

    const data: OrderCancelledEvent['data'] = {
        id: ticket.id,
        version: 1,
        ticket: {
            id: ticket.id,
        }
    }

    //@ts-ignore
    const msg: Message = {
        ack: jest.fn()
    }

    return { msg, data, ticket, listener }
}

it("updates the ticket, removing its orderId and publishes an event", async () => {
    const { msg, data, ticket, listener } = await setup();
    await listener.onMessage(data, msg);

    const updatedTicket = await Ticket.findById(ticket.id);
    expect(updatedTicket!.orderId).not.toBeDefined();

    expect(natsWrapper.client.publish).toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalled();
});

// it("acks the message", async () => {
//     const { msg, data, ticket, listener } = await setup();
//     await listener.onMessage(data, msg);
//     expect(msg.ack).toHaveBeenCalled();
// });