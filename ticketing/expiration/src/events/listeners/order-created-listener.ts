import { EventMetadata, Listener, OrderCreatedEvent, Subjects } from "@mehul-mrtickets/common";
import { expirationQueue } from "../../queues/expiration-queue";

export class OrderCreatedListener extends Listener<OrderCreatedEvent> {
    subject: Subjects.OrderCreated = Subjects.OrderCreated;

    async onMessage(data: OrderCreatedEvent["data"], metadata: EventMetadata): Promise<void> {
        const delay = Math.max(new Date(data.expiresAt).getTime() - Date.now(), 0);
        console.log("Waiting Time to process the job: ", delay);
        await expirationQueue.add(
            {
                orderId: data.id,
            },
            {
                delay,
                jobId: data.id,
            }
        );
    }
}