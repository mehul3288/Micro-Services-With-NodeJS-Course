import { OrderCancelledEvent, OutboxPublisher, Subjects } from "@mehul-mrtickets/common";

export class OrderCancelledPublisher extends OutboxPublisher<OrderCancelledEvent> {
    readonly subject = Subjects.OrderCancelled;
    partitionKey(data: OrderCancelledEvent["data"]): string {
        return data.ticket.id;
    }
}