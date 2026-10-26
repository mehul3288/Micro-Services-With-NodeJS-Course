import path from "path";
import { MessageProviderPact } from "@pact-foundation/pact";
import { toExpirationCompleteEvent } from "../builders/expiration-event-builders";

describe("Expiration Service - Events Provider Verification", () => {
    const pact = new MessageProviderPact({
        messageProviders: {
            "an expiration:complete message": () => toExpirationCompleteEvent("order-123"),
        },
        pactUrls: [
            path.resolve(process.cwd(), "../pacts/orders-service-expiration-service.json"),
        ],
    });

    it("satisfies the orders-service contract for expiration events", async () => {
        await pact.verify();
    });
});
