import { RefundRequestedEvent, OutboxPublisher, Subjects } from "@mehul-mrtickets/common";

export class RefundRequestedPublisher extends OutboxPublisher<RefundRequestedEvent> {
    readonly subject: Subjects.RefundRequested = Subjects.RefundRequested;

    partitionKey(data: RefundRequestedEvent["data"]): string {
        return data.orderId;
    }
}
