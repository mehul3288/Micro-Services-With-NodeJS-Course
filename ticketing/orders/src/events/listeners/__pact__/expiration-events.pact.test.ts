import path from "path";
import { MessageConsumerPact, asynchronousBodyHandler, Matchers } from "@pact-foundation/pact";
import { ExpirationCompleteListener } from "../expiration-complete-listener";
import { Order } from "../../../models/order";
import { Ticket } from "../../../models/ticket";
import { OrderStatus } from "@mehul-mrtickets/common";
import mongoose from "mongoose";

const { like } = Matchers;

describe("Orders Service - Expiration Events Consumer Pact", () => {
    const messagePact = new MessageConsumerPact({
        consumer: "orders-service",
        provider: "expiration-service",
        dir: path.resolve(process.cwd(), "../pacts"),
        pactfileWriteMode: "update",
        logLevel: "error",
    });

    describe("receiving expiration:complete event", () => {
        it("accepts and cancels order on expiration:complete message", async () => {
            const ticket = Ticket.build({
                id: new mongoose.Types.ObjectId().toHexString(),
                title: "Concert",
                price: 20,
            });
            await ticket.save();

            const order = Order.build({
                userId: "user-123",
                status: OrderStatus.Created,
                expiresAt: new Date(),
                ticket,
            });
            await order.save();
            const orderId = order.id;

            await messagePact
                .expectsToReceive("an expiration:complete message")
                .withContent({
                    orderId: like(orderId),
                })
                .verify(
                    asynchronousBodyHandler(async (message: any) => {
                        const listener = new ExpirationCompleteListener();
                        await listener.onMessage(message, {} as any);

                        const updatedOrder = await Order.findById(orderId);
                        expect(updatedOrder).toBeDefined();
                        expect(updatedOrder!.status).toBe(OrderStatus.Cancelled);
                    })
                );
        });
    });
});
