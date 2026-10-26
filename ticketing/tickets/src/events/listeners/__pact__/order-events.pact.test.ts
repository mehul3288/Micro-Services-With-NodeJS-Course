import path from "path";
import { MessageConsumerPact, asynchronousBodyHandler, Matchers } from "@pact-foundation/pact";
import { OrderCreatedListener } from "../order-created-listener";
import { OrderCancelledListener } from "../order-cancelled-listener";
import { Ticket } from "../../../models/ticket";
import mongoose from "mongoose";

const { like } = Matchers;

describe("Tickets Service - Order Events Consumer Pact", () => {
    const messagePact = new MessageConsumerPact({
        consumer: "tickets-service",
        provider: "orders-service",
        dir: path.resolve(process.cwd(), "../pacts"),
        pactfileWriteMode: "update",
        logLevel: "error",
    });

    describe("receiving order:created event", () => {
        it("accepts and processes an order:created message", async () => {
            const ticket = Ticket.build({
                title: "Concert",
                price: 20,
                userId: "user-123",
            });
            await ticket.save();

            const orderId = new mongoose.Types.ObjectId().toHexString();

            await messagePact
                .expectsToReceive("an order:created message")
                .withContent({
                    id: like(orderId),
                    version: like(0),
                    status: like("created"),
                    userId: like("user-123"),
                    expiresAt: like(new Date().toISOString()),
                    ticket: {
                        id: like(ticket.id),
                        price: like(20),
                    },
                })
                .verify(
                    asynchronousBodyHandler(async (message: any) => {
                        const listener = new OrderCreatedListener();
                        await listener.onMessage(message, {} as any);

                        const updatedTicket = await Ticket.findById(ticket.id);
                        expect(updatedTicket).toBeDefined();
                        expect(updatedTicket!.orderId).toBe(message.id);
                    })
                );
        });
    });

    describe("receiving order:cancelled event", () => {
        it("accepts and processes an order:cancelled message", async () => {
            const orderId = new mongoose.Types.ObjectId().toHexString();
            const ticket = Ticket.build({
                title: "Concert",
                price: 20,
                userId: "user-123",
            });
            ticket.set({ orderId });
            await ticket.save();

            await messagePact
                .expectsToReceive("an order:cancelled message")
                .withContent({
                    id: like(orderId),
                    version: like(1),
                    ticket: {
                        id: like(ticket.id),
                    },
                })
                .verify(
                    asynchronousBodyHandler(async (message: any) => {
                        const listener = new OrderCancelledListener();
                        await listener.onMessage(message, {} as any);

                        const updatedTicket = await Ticket.findById(ticket.id);
                        expect(updatedTicket).toBeDefined();
                        expect(updatedTicket!.orderId).toBeUndefined();
                    })
                );
        });
    });
});
