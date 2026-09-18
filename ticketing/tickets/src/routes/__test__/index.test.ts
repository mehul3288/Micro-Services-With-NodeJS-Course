import request from "supertest"
import { app } from "../../app"
import { Ticket } from "../../models/ticket"

const createTicket = (title: string, price: number) => {
    return request(app)
        .post("/api/tickets")
        .set("Cookie", global.signin())
        .send({
            title,
            price
        })
}

it("can fetch a list of tickets", async () => {
    await createTicket("Ticket", 20)
    await createTicket("Ticket2", 40)
    await createTicket("Ticket3", 60)

    const response = await request(app)
        .get("/api/tickets")
        .send()
    expect(response.body.length).toEqual(3);
})