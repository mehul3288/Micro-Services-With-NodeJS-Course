import path from "path";
import { MessageConsumerPact, asynchronousBodyHandler, Matchers } from "@pact-foundation/pact";
import { OrderCreatedListener } from "../order-created-listener";
import { OrderCancelledListener } from "../order-cancelled-listener";
import { RefundRequestedListener } from "../refund-requested-listener";
import { Order } from "../../../models/order";
import { Payment } from "../../../models/payment";
import { OrderStatus, PaymentStatus } from "@mehul-mrtickets/common";
import mongoose from "mongoose";

jest.mock("../../../services/stripe-client", () => ({
    refundCharge: jest.fn().mockResolvedValue({ id: "re_test_123" }),
}));

const { like } = Matchers;

describe("Payments Service - Order Events Consumer Pact", () => {
    const messagePact = new MessageConsumerPact({
        consumer: "payments-service",
        provider: "orders-service",
        dir: path.resolve(process.cwd(), "../pacts"),
        pactfileWriteMode: "update",
        logLevel: "error",
    });

    describe("receiving order:created event", () => {
        it("accepts and processes an order:created message", async () => {
            const orderId = new mongoose.Types.ObjectId().toHexString();

            await messagePact
                .expectsToReceive("an order:created message for payment")
                .withContent({
                    id: like(orderId),
                    version: like(0),
                    status: like(OrderStatus.Created),
                    userId: like("user-123"),
                    expiresAt: like(new Date().toISOString()),
                    ticket: {
                        id: like("ticket-123"),
                        price: like(20),
                    },
                })
                .verify(
                    asynchronousBodyHandler(async (message: any) => {
                        const listener = new OrderCreatedListener();
                        await listener.onMessage(message, {} as any);

                        const order = await Order.findById(message.id);
                        expect(order).toBeDefined();
                        expect(order!.price).toBe(20);
                        expect(order!.status).toBe(OrderStatus.Created);
                    })
                );
        });
    });

    describe("receiving order:cancelled event", () => {
        it("accepts and processes an order:cancelled message", async () => {
            const orderId = new mongoose.Types.ObjectId().toHexString();
            const order = Order.build({
                id: orderId,
                version: 0,
                userId: "user-123",
                price: 20,
                status: OrderStatus.Created,
                expiresAt: new Date(),
            });
            await order.save();

            await messagePact
                .expectsToReceive("an order:cancelled message for payment")
                .withContent({
                    id: like(orderId),
                    version: like(1),
                    ticket: {
                        id: like("ticket-123"),
                    },
                })
                .verify(
                    asynchronousBodyHandler(async (message: any) => {
                        const listener = new OrderCancelledListener();
                        await listener.onMessage(message, {} as any);

                        const updatedOrder = await Order.findById(message.id);
                        expect(updatedOrder).toBeDefined();
                        expect(updatedOrder!.status).toBe(OrderStatus.Cancelled);
                    })
                );
        });
    });

    describe("receiving refund:requested event", () => {
        it("accepts and processes a refund:requested message", async () => {
            const orderId = new mongoose.Types.ObjectId().toHexString();
            const payment = Payment.build({
                orderId,
                stripeId: "ch_test_123",
                status: PaymentStatus.Succeeded,
            });
            await payment.save();

            await messagePact
                .expectsToReceive("a refund:requested message")
                .withContent({
                    orderId: like(orderId),
                    paymentId: like(payment.id),
                    reason: like("Order expired or was cancelled before payment completed"),
                })
                .verify(
                    asynchronousBodyHandler(async (message: any) => {
                        const listener = new RefundRequestedListener();
                        await listener.onMessage(message, {} as any);

                        const updatedPayment = await Payment.findById(payment.id);
                        expect(updatedPayment).toBeDefined();
                        expect(updatedPayment!.status).toBe(PaymentStatus.Refunded);
                    })
                );
        });
    });
});
