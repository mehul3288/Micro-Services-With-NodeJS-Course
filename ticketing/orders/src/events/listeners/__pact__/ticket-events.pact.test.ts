import path from "path";
import { MessageConsumerPact, asynchronousBodyHandler, Matchers } from "@pact-foundation/pact";
import { TicketCreatedListener } from "../ticket-created-listener";
import { TicketUpdatedListener } from "../ticket-updated-listener";
import { Ticket } from "../../../models/ticket";
import mongoose from "mongoose";

const { like } = Matchers;

describe("Orders Service - Tickets Events Consumer Pact", () => {
    const messagePact = new MessageConsumerPact({
        consumer: "orders-service",
        provider: "tickets-service",
        dir: path.resolve(process.cwd(), "../pacts"),
        pactfileWriteMode: "update",
        logLevel: "error",
    });

    describe("receiving ticket:created event", () => {
        it("accepts and processes a valid ticket:created message", async () => {
            const ticketId = new mongoose.Types.ObjectId().toHexString();
            await messagePact
                .expectsToReceive("a ticket:created message")
                .withContent({
                    id: like(ticketId),
                    title: like("Concert"),
                    price: like(20),
                    userId: like("user-123"),
                    version: like(0),
                })
                .verify(
                    asynchronousBodyHandler(async (message: any) => {
                        const listener = new TicketCreatedListener();
                        await listener.onMessage(message, {} as any);

                        const ticket = await Ticket.findById(message.id);
                        expect(ticket).toBeDefined();
                        expect(ticket!.title).toBe(message.title);
                        expect(ticket!.price).toBe(message.price);
                    })
                );
        });
    });

    describe("receiving ticket:updated event", () => {
        it("accepts and processes a valid ticket:updated message", async () => {
            const initialTicket = Ticket.build({
                id: new mongoose.Types.ObjectId().toHexString(),
                title: "Old Concert",
                price: 15,
            });
            await initialTicket.save();

            await messagePact
                .expectsToReceive("a ticket:updated message")
                .withContent({
                    id: like(initialTicket.id),
                    title: like("Updated Concert"),
                    price: like(25),
                    userId: like("user-123"),
                    version: like(1),
                })
                .verify(
                    asynchronousBodyHandler(async (message: any) => {
                        const listener = new TicketUpdatedListener();
                        await listener.onMessage(message, {} as any);

                        const ticket = await Ticket.findById(message.id);
                        expect(ticket).toBeDefined();
                        expect(ticket!.title).toBe(message.title);
                        expect(ticket!.price).toBe(message.price);
                        expect(ticket!.version).toBe(1);
                    })
                );
        });
    });
});
