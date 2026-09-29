import { OrderCancelledEvent, Publisher, Subjects } from "@mehul-mrtickets/common";

export class OrderCancelledPublisher extends Publisher<OrderCancelledEvent> {
    subject: Subjects.OrderCancelled = Subjects.OrderCancelled;

}