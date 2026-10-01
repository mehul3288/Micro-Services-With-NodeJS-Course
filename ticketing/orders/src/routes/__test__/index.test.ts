import request from "supertest";
import { app } from "../../app";
import { Ticket } from "../../models/ticket";
import { Order } from "../../models/order";
import mongoose from "mongoose";

async function buildTicket(title: string, price: number) {
    const id = new mongoose.Types.ObjectId().toHexString();
    const ticket = Ticket.build({
        id,
        title,
        price
    })
    await ticket.save();
    return ticket;
}

it("Fetches orders for current user", async () => {
    //create a ticket
    const ticketOne = await buildTicket("concert", 10);
    const ticketTwo = await buildTicket("concert", 20);

    const ticketThree = await buildTicket("concert", 30);
    // const ticketFour = await buildTicket("concert", 40);

    const cookie1 = global.signin();
    const cookie2 = global.signin();

    await request(app)
        .post("/api/orders")
        .set("Cookie", cookie2)
        .send({
            ticketId: ticketThree._id
        })
        .expect(201);

    // await request(app)
    //     .post("/api/orders")
    //     .set("Cookie", cookie2)
    //     .send({
    //         ticketId: ticketFour._id
    //     })
    //     .expect(201);

    await request(app)
        .post("/api/orders")
        .set("Cookie", cookie1)
        .send({
            ticketId: ticketOne._id
        })
        .expect(201)

    await request(app)
        .post("/api/orders")
        .set("Cookie", cookie1)
        .send({
            ticketId: ticketTwo._id
        })
        .expect(201)

    const response = await request(app)
        .get("/api/orders")
        .set("Cookie", cookie1)
        .expect(200);

    // console.log(response.body)
    // expect(response.body.length).toEqual(2);

    // console.log(ticketOne._id.toString())
    expect(response.body.length).toEqual(2);
    expect(response.body[0].ticket.id).toEqual(ticketOne._id.toString());
    expect(response.body[1].ticket.id).toEqual(ticketTwo._id.toString());

    const response2 = await request(app)
        .get("/api/orders")
        .set("Cookie", cookie2)
        .expect(200);
    // console.log(response2.body)
    expect(response2.body.length).toEqual(1);
    expect(response2.body[0].ticket.id).toEqual(ticketThree._id.toString());
})
