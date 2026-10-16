import { Subjects } from "./subjects";

export interface PaymentRefundedEvent {
    subject: Subjects.PaymentRefunded;
    data: {
        paymentId: string;
        orderId: string;
        stripeRefundId?: string;
    };
}
