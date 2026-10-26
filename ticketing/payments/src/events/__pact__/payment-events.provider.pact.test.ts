import path from "path";
import { MessageProviderPact } from "@pact-foundation/pact";
import { toPaymentCreatedEvent } from "../builders/payment-event-builders";

describe("Payments Service - Events Provider Verification", () => {
    const mockPayment: any = {
        id: "payment-123",
        orderId: "order-123",
        stripeId: "ch_test_123",
    };

    const pact = new MessageProviderPact({
        messageProviders: {
            "a payment:created message": () => toPaymentCreatedEvent(mockPayment),
        },
        pactUrls: [
            path.resolve(process.cwd(), "../pacts/orders-service-payments-service.json"),
        ],
    });

    it("satisfies the orders-service contract for payment events", async () => {
        await pact.verify();
    });
});
