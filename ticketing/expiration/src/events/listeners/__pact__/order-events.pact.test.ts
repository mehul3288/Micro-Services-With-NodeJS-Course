import path from "path";
import { MessageConsumerPact, asynchronousBodyHandler, Matchers } from "@pact-foundation/pact";
import { OrderCreatedListener } from "../order-created-listener";
import { expirationQueue } from "../../../queues/expiration-queue";

jest.mock("../../../queues/expiration-queue", () => ({
    expirationQueue: {
        add: jest.fn().mockResolvedValue({}),
    },
}));

const { like } = Matchers;

describe("Expiration Service - Order Events Consumer Pact", () => {
    const messagePact = new MessageConsumerPact({
        consumer: "expiration-service",
        provider: "orders-service",
        dir: path.resolve(process.cwd(), "../pacts"),
        pactfileWriteMode: "update",
        logLevel: "error",
    });

    describe("receiving order:created event", () => {
        it("accepts and schedules expiration for order:created message", async () => {
            const expiresAt = new Date(Date.now() + 60000).toISOString();

            await messagePact
                .expectsToReceive("an order:created message for expiration")
                .withContent({
                    id: like("order-123"),
                    version: like(0),
                    status: like("created"),
                    userId: like("user-123"),
                    expiresAt: like(expiresAt),
                    ticket: {
                        id: like("ticket-123"),
                        price: like(20),
                    },
                })
                .verify(
                    asynchronousBodyHandler(async (message: any) => {
                        const listener = new OrderCreatedListener();
                        await listener.onMessage(message, {} as any);

                        expect(expirationQueue.add).toHaveBeenCalledWith(
                            { orderId: message.id },
                            expect.objectContaining({
                                jobId: message.id,
                            })
                        );
                    })
                );
        });
    });
});
