import { PaymentDoc } from "../../models/payment";
import { PaymentCreatedEvent, PaymentRefundedEvent } from "@mehul-mrtickets/common";

export const toPaymentCreatedEvent = (payment: PaymentDoc): PaymentCreatedEvent["data"] => ({
    id: payment.id,
    orderId: payment.orderId,
    stripeId: payment.stripeId,
});

export const toPaymentRefundedEvent = (
    payment: PaymentDoc,
    stripeRefundId: string
): PaymentRefundedEvent["data"] => ({
    paymentId: payment.id,
    orderId: payment.orderId,
    stripeRefundId,
});
