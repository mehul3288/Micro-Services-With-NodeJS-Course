import { TicketUpdateEvent } from "@mehul-mrtickets/common";
import { TicketUpdatedListener } from "../ticket-updated-listener"
import { natsWrapper } from "../../../nats-wrapper";
import mongoose from "mongoose";
import { Message } from "node-nats-streaming";
import { Ticket } from "../../../models/ticket";

const setup = async () => {
    // create a listener
    const listener = new TicketUpdatedListener(natsWrapper.client);
    // Created and save a ticket
    const ticket = Ticket.build({
        id: new mongoose.Types.ObjectId().toHexString(),
        title: 'concert',
        price: 10,
    })
    await ticket.save();
    // Create a fake data object
    const data: TicketUpdateEvent['data'] = {
        id: ticket.id,
        version: ticket.version + 1,
        title: 'new concert',
        price: 20,
        userId: new mongoose.Types.ObjectId().toHexString()
    }
    // Create a fake msg object
    //@ts-ignore
    const msg: Message = {
        ack: jest.fn()
    }
    // returnn all tthis stuff
    return { listener, ticket, data, msg }
}

it("finds, updates and saves a ticket", async () => {
    const { listener, ticket, data, msg } = await setup();

    await listener.onMessage(data, msg);

    const updatedTicket = await Ticket.findById(ticket.id);
    expect(updatedTicket).toBeDefined();
    expect(updatedTicket!.title).toEqual(data.title);
    expect(updatedTicket!.price).toEqual(data.price);
    expect(updatedTicket!.version).toEqual(data.version);
})

it("acks the message", async () => {
    const { listener, ticket, data, msg } = await setup();
    await listener.onMessage(data, msg);
    expect(msg.ack).toHaveBeenCalled();
})

it("does not call ack if the event has a skipped version number", async () => {
    const { listener, data, msg } = await setup();
    data.version = 10;
    try {
        await listener.onMessage(data, msg);
    } catch (error) {

    }
    expect(msg.ack).not.toHaveBeenCalled();
})

