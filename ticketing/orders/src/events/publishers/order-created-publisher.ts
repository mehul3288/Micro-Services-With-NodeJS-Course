import { OrderCreatedEvent, OutboxPublisher, Subjects } from "@mehul-mrtickets/common";

export class OrderCreatedPublisher extends OutboxPublisher<OrderCreatedEvent> {
    readonly subject = Subjects.OrderCreated;
    partitionKey(data: OrderCreatedEvent["data"]): string {
        return data.ticket.id;
    }
}