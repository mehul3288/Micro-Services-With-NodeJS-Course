import request from "supertest";
import { app } from "../../app";
import { Ticket } from "../../models/ticket";
import { Order } from "../../models/order";
import mongoose from "mongoose";

it("fetches the order", async () => {
    const ticket = Ticket.build({
        id: new mongoose.Types.ObjectId().toHexString(),
        title: "Concert",
        price: 100
    })
    await ticket.save();

    const user = global.signin();
    const { body: order } = await request(app)
        .post("/api/orders")
        .set("Cookie", user)
        .send({
            ticketId: ticket._id
        })
        .expect(201);

    const response = await request(app)
        .get("/api/orders/" + order.id)
        .set("Cookie", user)
        .expect(200);

    console.log(response.body);
    expect(response.body.id).toEqual(order.id);
    expect(response.body.ticket.id).toEqual(ticket._id.toString());
})

it("Returns an error if the user tries to access another users order", async () => {
    const ticket = Ticket.build({
        id: new mongoose.Types.ObjectId().toHexString(),
        title: "Concert",
        price: 100
    })
    await ticket.save();

    const user = global.signin();
    const { body: order } = await request(app)
        .post("/api/orders")
        .set("Cookie", user)
        .send({
            ticketId: ticket._id
        })
        .expect(201);

    const response = await request(app)
        .get("/api/orders/" + order.id)
        .set("Cookie", global.signin())
        .expect(401);

})