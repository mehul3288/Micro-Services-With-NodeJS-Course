import { EventMetadata, Listener, PaymentStatus, RefundRequestedEvent, Subjects } from "@mehul-mrtickets/common";
import { Payment } from "../../models/payment";
import { refundCharge } from "../../services/stripe-client";
import { PaymentRefundedPublisher } from "../publishers/payment-refunded-publisher";

export class RefundRequestedListener extends Listener<RefundRequestedEvent> {
    readonly subject: Subjects.RefundRequested = Subjects.RefundRequested;

    async onMessage(data: RefundRequestedEvent["data"], metadata: EventMetadata): Promise<void> {
        let payment = null;
        if (data.paymentId) {
            payment = await Payment.findById(data.paymentId).session(metadata.session || null);
        }
        if (!payment && data.orderId) {
            payment = await Payment.findOne({ orderId: data.orderId }).session(metadata.session || null);
        }

        if (!payment) {
            return;
        }

        if (payment.status === PaymentStatus.Refunded) {
            return;
        }

        // Call Stripe refund via circuit breaker with idempotency key
        const refund = await refundCharge(payment.stripeId, `refund-${payment.id}`);

        payment.set({ status: PaymentStatus.Refunded });
        await payment.save({ session: metadata.session });

        await new PaymentRefundedPublisher().publish({
            paymentId: payment.id,
            orderId: payment.orderId,
            stripeRefundId: refund.id,
        }, metadata.session);
    }
}
