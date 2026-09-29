import { OrderCreatedEvent, Publisher, Subjects } from "@mehul-mrtickets/common";

export class OrderCreatedPublisher extends Publisher<OrderCreatedEvent> {
    subject: Subjects.OrderCreated = Subjects.OrderCreated;

}