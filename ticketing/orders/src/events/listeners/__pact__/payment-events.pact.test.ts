import path from "path";
import { MessageConsumerPact, asynchronousBodyHandler, Matchers } from "@pact-foundation/pact";
import { PaymentCreatedListener } from "../payment-created-listener";
import { Order } from "../../../models/order";
import { OrderStatus } from "@mehul-mrtickets/common";
import mongoose from "mongoose";

const { like } = Matchers;

describe("Orders Service - Payment Events Consumer Pact", () => {
    const messagePact = new MessageConsumerPact({
        consumer: "orders-service",
        provider: "payments-service",
        dir: path.resolve(process.cwd(), "../pacts"),
        pactfileWriteMode: "update",
        logLevel: "error",
    });

    describe("receiving payment:created event", () => {
        it("accepts and completes order on payment:created message", async () => {
            const order = Order.build({
                userId: "user-123",
                status: OrderStatus.Created,
                expiresAt: new Date(Date.now() + 60000),
                ticket: new mongoose.Types.ObjectId().toHexString() as any,
            });
            await order.save();
            const orderId = order.id;

            const paymentId = new mongoose.Types.ObjectId().toHexString();

            await messagePact
                .expectsToReceive("a payment:created message")
                .withContent({
                    id: like(paymentId),
                    orderId: like(orderId),
                    stripeId: like("ch_stripe_123"),
                })
                .verify(
                    asynchronousBodyHandler(async (message: any) => {
                        const listener = new PaymentCreatedListener();
                        await listener.onMessage(message, {} as any);

                        const updatedOrder = await Order.findById(orderId);
                        expect(updatedOrder).toBeDefined();
                        expect(updatedOrder!.status).toBe(OrderStatus.Complete);
                    })
                );
        });
    });
});
