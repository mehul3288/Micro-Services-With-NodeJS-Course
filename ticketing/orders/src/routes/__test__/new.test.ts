import mongoose from "mongoose";
import request from "supertest";
import { app } from "../../app";
import { Ticket } from "../../models/ticket";
import { Order, OrderStatus } from "../../models/order";
import { natsWrapper } from "../../nats-wrapper";
it("returns an error if the ticket doesn't exist", async () => {
    const ticketId = new mongoose.Types.ObjectId();

    await request(app)
        .post("/api/orders")
        .set("Cookie", global.signin())
        .send({
            ticketId: ticketId
        })
        .expect(404);
})

it("returns an error if the ticket is already reserved", async () => {

    const ticket = Ticket.build({
        id: new mongoose.Types.ObjectId().toHexString(),
        title: 'concert',
        price: 20
    })
    await ticket.save();
    const order = Order.build({
        userId: 'dfhghfgh',
        status: OrderStatus.Created,
        ticket,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000)
    })
    await order.save();
    await request(app)
        .post("/api/orders")
        .set("Cookie", global.signin())
        .send({
            ticketId: ticket._id
        })
        .expect(400);
});

it("reserves a ticket", async () => {
    const ticket = Ticket.build({
        id: new mongoose.Types.ObjectId().toHexString(),
        title: 'concert',
        price: 20
    })
    await ticket.save();
    console.log(ticket._id.toString())
    const response = await request(app)
        .post("/api/orders")
        .set("Cookie", global.signin())
        .send({
            ticketId: ticket._id
        })
        .expect(201);

    const order = await Order.findById(response.body.id).populate("ticket");
    console.log(order)
    expect(order?.ticket._id).toEqual(ticket._id);
    // expect(order!.ticket.toString()).toEqual(ticket._id.toString());

})

it("emits an order created event", async () => {
    const ticket = Ticket.build({
        id: new mongoose.Types.ObjectId().toHexString(),
        title: 'concert',
        price: 20
    })
    await ticket.save();
    console.log(ticket._id.toString())
    const response = await request(app)
        .post("/api/orders")
        .set("Cookie", global.signin())
        .send({
            ticketId: ticket._id
        })
        .expect(201);
    expect(natsWrapper.client.publish).toHaveBeenCalled();
})