import { EventMetadata, TicketCreatedEvent } from "@mehul-mrtickets/common";
import { TicketCreatedListener } from "../ticket-created-listener";
import mongoose from "mongoose";
import { Ticket } from "../../../models/ticket";

const setup = () => {
    const listener = new TicketCreatedListener();

    const data: TicketCreatedEvent["data"] = {
        id: new mongoose.Types.ObjectId().toHexString(),
        title: "concert",
        price: 10,
        userId: new mongoose.Types.ObjectId().toHexString(),
        version: 0,
    };

    const metadata: EventMetadata = {
        eventId: "test-event-id",
        occurredAt: new Date().toISOString(),
    };

    return { metadata, data, listener };
};

it("creates and saves a ticket", async () => {
    const { listener, data, metadata } = setup();

    await listener.onMessage(data, metadata);

    const ticket = await Ticket.findById(data.id);
    expect(ticket).toBeDefined();
    expect(ticket!.title).toEqual(data.title);
    expect(ticket!.price).toEqual(data.price);
});

it("resolves successfully when message is processed", async () => {
    const { listener, data, metadata } = setup();

    await expect(listener.onMessage(data, metadata)).resolves.not.toThrow();
});
