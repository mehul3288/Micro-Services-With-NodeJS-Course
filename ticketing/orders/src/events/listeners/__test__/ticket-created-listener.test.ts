import { TicketCreatedEvent } from "@mehul-mrtickets/common";
import { TicketCreatedListener } from "../ticket-created-listener"
import { natsWrapper } from "../../../nats-wrapper";
import mongoose from "mongoose";
import { Message } from "node-nats-streaming";
import { Ticket } from "../../../models/ticket";

const setup = () => {
    const listener = new TicketCreatedListener(natsWrapper.client);
    // create an instance of the listener
    const data: TicketCreatedEvent['data'] = {
        id: new mongoose.Types.ObjectId().toHexString(),
        title: 'concert',
        price: 10,
        userId: new mongoose.Types.ObjectId().toHexString(),
        version: 0
    }
    // create a fake data event
    //@ts-ignore
    const msg: Message = {
        ack: jest.fn()
    }
    // create a fake message object
    return { msg, data, listener };
}

it("creates and saves a ticket", async () => {
    const { listener, data, msg } = setup();
    // call the onMessage function with the data object and message object
    await listener.onMessage(data, msg);
    // write assertions to ensure that a ticket was created
    const ticket = await Ticket.findById(data.id);
    expect(ticket).toBeDefined();
    expect(ticket!.title).toEqual(data.title);
    expect(ticket!.price).toEqual(data.price);
})

it("acks the message", async () => {
    const { listener, data, msg } = setup();
    // call the onMessage function with the data object and message object
    await listener.onMessage(data, msg);
    // Write assertions to make sure ack function was called
    expect(msg.ack).toHaveBeenCalled();
})

