import { ticketCache } from "../ticket-cache";

describe("ticketCache service", () => {
    beforeEach(async () => {
        await ticketCache.client.flushall();
    });

    afterAll(async () => {
        await ticketCache.close();
    });

    it("returns null on cache miss", async () => {
        const ticket = await ticketCache.get("non-existent-id");
        expect(ticket).toBeNull();
    });

    it("can set and get an individual ticket", async () => {
        const mockTicket = {
            id: "ticket-123",
            title: "Coldplay Concert",
            price: 150,
            userId: "user-456",
            version: 0,
        };

        await ticketCache.set(mockTicket);
        const cached = await ticketCache.get("ticket-123");

        expect(cached).toBeDefined();
        expect(cached.id).toEqual("ticket-123");
        expect(cached.title).toEqual("Coldplay Concert");
        expect(cached.price).toEqual(150);
    });

    it("can set and get the catalog list", async () => {
        const mockList = {
            tickets: [
                { id: "1", title: "Concert A", price: 50 },
                { id: "2", title: "Concert B", price: 75 },
            ],
            nextCursor: "2",
        };

        await ticketCache.setList(mockList);
        const cached = await ticketCache.getList();

        expect(cached).toBeDefined();
        expect(cached!.tickets.length).toEqual(2);
        expect(cached!.nextCursor).toEqual("2");
    });

    it("invalidates both tickets:list and ticket:id", async () => {
        await ticketCache.set({ id: "ticket-999", title: "Festival", price: 100 });
        await ticketCache.setList({ tickets: [{ id: "ticket-999" }], nextCursor: null });

        // Invalidate ticket-999
        await ticketCache.invalidate("ticket-999");

        const cachedTicket = await ticketCache.get("ticket-999");
        const cachedList = await ticketCache.getList();

        expect(cachedTicket).toBeNull();
        expect(cachedList).toBeNull();
    });

    it("fails open gracefully when Redis command fails", async () => {
        // Spy on redisClient.get and simulate a connection rejection
        const originalGet = ticketCache.client.get;
        jest.spyOn(ticketCache.client, "get").mockRejectedValueOnce(new Error("Redis cluster down"));

        const result = await ticketCache.get("any-id");
        expect(result).toBeNull(); // Must fail open, not throw!

        ticketCache.client.get = originalGet;
    });
});
