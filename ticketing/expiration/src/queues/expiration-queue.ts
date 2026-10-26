import Queue from "bull";
import { ExpirationCompletePublisher } from "../events/publishers/expiration-complete-publisher";
import { kafkaWrapper } from "../kafka-wrapper";
import { toExpirationCompleteEvent } from "../events/builders/expiration-event-builders";

interface Payload {
    orderId: string;
}

const expirationQueue = new Queue<Payload>("order:expiration", {
    redis: {
        host: process.env.REDIS_HOST,
    },
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: "exponential",
            delay: 1000,
        },
    },
});

expirationQueue.process(async (job) => {
    await new ExpirationCompletePublisher(kafkaWrapper.producer).publish(
        toExpirationCompleteEvent(job.data.orderId)
    );
});

export { expirationQueue };