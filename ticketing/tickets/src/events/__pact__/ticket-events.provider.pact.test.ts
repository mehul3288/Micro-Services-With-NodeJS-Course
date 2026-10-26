import path from "path";
import { MessageProviderPact } from "@pact-foundation/pact";
import { toTicketCreatedEvent, toTicketUpdatedEvent } from "../builders/ticket-event-builders";

describe("Tickets Service - Events Provider Verification", () => {
    const pact = new MessageProviderPact({
        messageProviders: {
            "a ticket:created message": () => {
                return toTicketCreatedEvent({
                    id: "6ad735724c665af386309596",
                    title: "Concert",
                    price: 20,
                    userId: "user-123",
                    version: 0,
                } as any);
            },
            "a ticket:updated message": () => {
                return toTicketUpdatedEvent({
                    id: "6ad735724c665af386309598",
                    title: "Updated Concert",
                    price: 25,
                    userId: "user-123",
                    version: 1,
                    orderId: undefined,
                } as any);
            },
        },
        pactUrls: [
            path.resolve(process.cwd(), "../pacts/orders-service-tickets-service.json"),
        ],
    });

    it("satisfies the orders service contract for ticket events", async () => {
        await pact.verify();
    });
});
