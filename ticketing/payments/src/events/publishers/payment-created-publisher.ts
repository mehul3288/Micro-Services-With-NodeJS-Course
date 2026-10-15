import { Subjects, Publisher, PaymentCreatedEvent } from "@mehul-mrtickets/common";

export class PaymentCreatedPublisher extends Publisher<PaymentCreatedEvent> {
    readonly subject = Subjects.PaymentCreated;
    partitionKey(data: PaymentCreatedEvent["data"]): string {
        return data.orderId;
    }
}