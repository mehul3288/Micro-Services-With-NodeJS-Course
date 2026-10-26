import path from "path";
import { MessageProviderPact } from "@pact-foundation/pact";
import {
    toOrderCreatedEvent,
    toOrderCancelledEvent,
    toRefundRequestedEvent,
} from "../builders/order-event-builders";
import { OrderStatus } from "@mehul-mrtickets/common";

describe("Orders Service - Events Provider Verification", () => {
    const mockOrder: any = {
        _id: { toHexString: () => "order-123" },
        id: "order-123",
        version: 0,
        status: OrderStatus.Created,
        userId: "user-123",
        expiresAt: new Date(),
        ticket: {
            id: "ticket-123",
            price: 20,
        },
    };

    const mockCancelledOrder: any = {
        _id: { toHexString: () => "order-123" },
        id: "order-123",
        version: 1,
        ticket: {
            id: "ticket-123",
        },
    };

    const messageProviders = {
        "an order:created message": () => toOrderCreatedEvent(mockOrder),
        "an order:cancelled message": () => toOrderCancelledEvent(mockCancelledOrder),
        "an order:created message for payment": () => toOrderCreatedEvent(mockOrder),
        "an order:cancelled message for payment": () => toOrderCancelledEvent(mockCancelledOrder),
        "an order:created message for expiration": () => toOrderCreatedEvent(mockOrder),
        "a refund:requested message": () =>
            toRefundRequestedEvent("order-123", "ch_test_123", "Order expired or was cancelled before payment completed"),
    };

    it("satisfies the tickets-service contract", async () => {
        const pact = new MessageProviderPact({
            messageProviders,
            pactUrls: [
                path.resolve(process.cwd(), "../pacts/tickets-service-orders-service.json"),
            ],
        });
        await pact.verify();
    });

    it("satisfies the payments-service contract", async () => {
        const pact = new MessageProviderPact({
            messageProviders,
            pactUrls: [
                path.resolve(process.cwd(), "../pacts/payments-service-orders-service.json"),
            ],
        });
        await pact.verify();
    });

    it("satisfies the expiration-service contract", async () => {
        const pact = new MessageProviderPact({
            messageProviders,
            pactUrls: [
                path.resolve(process.cwd(), "../pacts/expiration-service-orders-service.json"),
            ],
        });
        await pact.verify();
    });
});
