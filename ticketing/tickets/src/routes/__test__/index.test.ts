import request from "supertest";
import { app } from "../../app";

const createTicket = (title: string, price: number) => {
    return request(app)
        .post("/api/tickets")
        .set("Cookie", global.signin())
        .send({
            title,
            price,
        });
};

describe("GET /api/tickets pagination", () => {
    it("can fetch a list of tickets with nextCursor", async () => {
        await createTicket("Ticket 1", 20);
        await createTicket("Ticket 2", 40);
        await createTicket("Ticket 3", 60);

        const response = await request(app).get("/api/tickets").send().expect(200);

        expect(response.body.tickets.length).toEqual(3);
        expect(response.body.nextCursor).toBeNull();
    });

    it("respects limit and returns nextCursor when more tickets exist", async () => {
        await createTicket("Ticket 1", 10);
        await createTicket("Ticket 2", 20);
        await createTicket("Ticket 3", 30);

        const response = await request(app)
            .get("/api/tickets?limit=2")
            .send()
            .expect(200);

        expect(response.body.tickets.length).toEqual(2);
        expect(response.body.nextCursor).toBeDefined();
        expect(response.body.nextCursor).toEqual(response.body.tickets[1].id);
    });

    it("supports cursor pagination with after query parameter", async () => {
        await createTicket("Ticket 1", 10);
        await createTicket("Ticket 2", 20);
        await createTicket("Ticket 3", 30);

        // Fetch page 1
        const page1 = await request(app)
            .get("/api/tickets?limit=2")
            .send()
            .expect(200);

        expect(page1.body.tickets.length).toEqual(2);
        const cursor = page1.body.nextCursor;

        // Fetch page 2 using after=cursor
        const page2 = await request(app)
            .get(`/api/tickets?limit=2&after=${cursor}`)
            .send()
            .expect(200);

        expect(page2.body.tickets.length).toEqual(1);
        expect(page2.body.tickets[0].title).toEqual("Ticket 3");
        expect(page2.body.nextCursor).toBeNull();
    });

    it("caps limit at 100", async () => {
        const response = await request(app)
            .get("/api/tickets?limit=250")
            .send()
            .expect(200);

        expect(response.body.tickets).toBeDefined();
    });
});