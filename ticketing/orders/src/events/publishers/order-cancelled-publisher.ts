import { OrderCancelledEvent, Publisher, Subjects } from "@mehul-mrtickets/common";

export class OrderCancelledPublisher extends Publisher<OrderCancelledEvent> {
    readonly subject = Subjects.OrderCancelled;
    partitionKey(data: OrderCancelledEvent["data"]): string {
        return data.ticket.id;
    }
}