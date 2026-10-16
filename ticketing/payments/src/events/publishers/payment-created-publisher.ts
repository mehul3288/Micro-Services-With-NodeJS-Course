import { Subjects, OutboxPublisher, PaymentCreatedEvent } from "@mehul-mrtickets/common";

export class PaymentCreatedPublisher extends OutboxPublisher<PaymentCreatedEvent> {
    readonly subject = Subjects.PaymentCreated;
    partitionKey(data: PaymentCreatedEvent["data"]): string {
        return data.orderId;
    }
}