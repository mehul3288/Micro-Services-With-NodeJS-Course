import mongoose from "mongoose";
import { EventMetadata, OrderStatus, PaymentStatus, RefundRequestedEvent, OutboxEvent, Subjects } from "@mehul-mrtickets/common";
import { Order } from "../../../models/order";
import { Payment } from "../../../models/payment";
import { RefundRequestedListener } from "../refund-requested-listener";
import { stripe } from "../../../stripe";

jest.mock("../../../stripe");

const setup = async () => {
    const listener = new RefundRequestedListener();

    const order = Order.build({
        id: new mongoose.Types.ObjectId().toHexString(),
        version: 0,
        userId: new mongoose.Types.ObjectId().toHexString(),
        price: 20,
        status: OrderStatus.Cancelled,
        expiresAt: new Date(Date.now() - 10000),
    });
    await order.save();

    const payment = Payment.build({
        orderId: order.id,
        stripeId: "ch_test_charge_123",
        status: PaymentStatus.Succeeded,
    });
    await payment.save();

    const data: RefundRequestedEvent["data"] = {
        orderId: order.id,
        paymentId: payment.id,
        reason: "Order expired before payment completed",
    };

    const metadata: EventMetadata = {
        eventId: "test-refund-event-id",
        occurredAt: new Date().toISOString(),
    };

    return { listener, order, payment, data, metadata };
};

describe("RefundRequestedListener", () => {
    it("calls stripe refund with idempotency key, sets payment status to refunded, and publishes PaymentRefunded outbox event", async () => {
        const { listener, payment, order, data, metadata } = await setup();

        await listener.onMessage(data, metadata);

        // Verify Stripe refund called
        expect(stripe.refunds.create).toHaveBeenCalled();
        const refundParams = (stripe.refunds.create as jest.Mock).mock.calls[0][0];
        const refundOpts = (stripe.refunds.create as jest.Mock).mock.calls[0][1];

        expect(refundParams.charge).toEqual(payment.stripeId);
        expect(refundOpts.idempotencyKey).toEqual(`refund-${payment.id}`);

        // Verify Payment updated
        const updatedPayment = await Payment.findById(payment.id);
        expect(updatedPayment!.status).toEqual(PaymentStatus.Refunded);

        // Verify Outbox event published
        const outboxEvents = await OutboxEvent.find({ eventType: Subjects.PaymentRefunded });
        expect(outboxEvents.length).toEqual(1);
        expect(outboxEvents[0].key).toEqual(order.id);

        const payload = JSON.parse(outboxEvents[0].payload);
        expect(payload.paymentId).toEqual(payment.id);
        expect(payload.orderId).toEqual(order.id);
    });

    it("does not call Stripe refund if payment is already refunded (idempotency)", async () => {
        const { listener, payment, data, metadata } = await setup();
        payment.set({ status: PaymentStatus.Refunded });
        await payment.save();

        (stripe.refunds.create as jest.Mock).mockClear();

        await listener.onMessage(data, metadata);

        expect(stripe.refunds.create).not.toHaveBeenCalled();
    });
});
