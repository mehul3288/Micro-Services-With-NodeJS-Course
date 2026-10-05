import { Subjects, Publisher, PaymentCreatedEvent } from "@mehul-mrtickets/common";

export class PaymentCreatedPublisher extends Publisher<PaymentCreatedEvent> {
    subject: Subjects.PaymentCreated = Subjects.PaymentCreated;
}