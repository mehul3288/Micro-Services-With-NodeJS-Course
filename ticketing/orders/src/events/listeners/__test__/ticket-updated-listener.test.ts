import { EventMetadata, TicketUpdateEvent } from "@mehul-mrtickets/common";
import { TicketUpdatedListener } from "../ticket-updated-listener";
import mongoose from "mongoose";
import { Ticket } from "../../../models/ticket";

const setup = async () => {
    const listener = new TicketUpdatedListener();
    const ticket = Ticket.build({
        id: new mongoose.Types.ObjectId().toHexString(),
        title: "concert",
        price: 10,
    });
    await ticket.save();

    const data: TicketUpdateEvent["data"] = {
        id: ticket.id,
        version: ticket.version + 1,
        title: "new concert",
        price: 20,
        userId: new mongoose.Types.ObjectId().toHexString(),
    };

    const metadata: EventMetadata = {
        eventId: "test-event-id",
        occurredAt: new Date().toISOString(),
    };

    return { listener, ticket, data, metadata };
};

it("finds, updates and saves a ticket", async () => {
    const { listener, ticket, data, metadata } = await setup();

    await listener.onMessage(data, metadata);

    const updatedTicket = await Ticket.findById(ticket.id);
    expect(updatedTicket).toBeDefined();
    expect(updatedTicket!.title).toEqual(data.title);
    expect(updatedTicket!.price).toEqual(data.price);
    expect(updatedTicket!.version).toEqual(data.version);
});

it("throws an error if the event has a skipped version number", async () => {
    const { listener, data, metadata } = await setup();
    data.version = 10;

    await expect(listener.onMessage(data, metadata)).rejects.toThrow("Ticket not found");
});

it("preserves reservedBy when updating a ticket", async () => {
    const { listener, ticket, data, metadata } = await setup();
    const orderId = new mongoose.Types.ObjectId().toHexString();

    await Ticket.reserve(ticket.id, orderId);

    await listener.onMessage(data, metadata);

    const updatedTicket = await Ticket.findById(ticket.id);
    expect(updatedTicket?.reservedBy).toEqual(orderId);
    expect(updatedTicket?.title).toEqual(data.title);
});
