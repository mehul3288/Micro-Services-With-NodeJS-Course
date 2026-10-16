import { PaymentRefundedEvent, OutboxPublisher, Subjects } from "@mehul-mrtickets/common";

export class PaymentRefundedPublisher extends OutboxPublisher<PaymentRefundedEvent> {
    readonly subject: Subjects.PaymentRefunded = Subjects.PaymentRefunded;

    partitionKey(data: PaymentRefundedEvent["data"]): string {
        return data.orderId;
    }
}
