import { ExpirationCompleteEvent, Publisher, Subjects } from "@mehul-mrtickets/common";

export class ExpirationCompletePublisher extends Publisher<ExpirationCompleteEvent> {
    readonly subject = Subjects.ExpirationComplete;
    partitionKey(data: ExpirationCompleteEvent["data"]): string {
        return data.orderId;
    }
}