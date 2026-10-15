import { OrderCreatedEvent, Publisher, Subjects } from "@mehul-mrtickets/common";

export class OrderCreatedPublisher extends Publisher<OrderCreatedEvent> {
    readonly subject = Subjects.OrderCreated;
    partitionKey(data: OrderCreatedEvent["data"]): string {
        return data.ticket.id;
    }
}