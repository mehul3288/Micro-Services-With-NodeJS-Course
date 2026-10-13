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
});

it("returns an error if the ticket is already reserved", async () => {
    const ticket = Ticket.build({
        id: new mongoose.Types.ObjectId().toHexString(),
        title: "concert",
        price: 20
    });
    await ticket.save();

    const orderId = new mongoose.Types.ObjectId().toHexString();
    await Ticket.reserve(ticket.id, orderId);

    await request(app)
        .post("/api/orders")
        .set("Cookie", global.signin())
        .send({
            ticketId: ticket.id
        })
        .expect(400);
});

it("reserves a ticket", async () => {
    const ticket = Ticket.build({
        id: new mongoose.Types.ObjectId().toHexString(),
        title: "concert",
        price: 20
    });
    await ticket.save();

    const response = await request(app)
        .post("/api/orders")
        .set("Cookie", global.signin())
        .send({
            ticketId: ticket.id
        })
        .expect(201);

    const order = await Order.findById(response.body.id).populate("ticket");
    expect(order?.ticket.id).toEqual(ticket.id);

    // Verify ticket has reservedBy set
    const updatedTicket = await Ticket.findById(ticket.id);
    expect(updatedTicket?.reservedBy).toEqual(order?.id);
});

it("emits an order created event", async () => {
    const ticket = Ticket.build({
        id: new mongoose.Types.ObjectId().toHexString(),
        title: "concert",
        price: 20
    });
    await ticket.save();

    await request(app)
        .post("/api/orders")
        .set("Cookie", global.signin())
        .send({
            ticketId: ticket.id
        })
        .expect(201);

    expect(natsWrapper.client.publish).toHaveBeenCalled();
});

it("handles concurrent reservation requests so only one succeeds", async () => {
    const ticket = Ticket.build({
        id: new mongoose.Types.ObjectId().toHexString(),
        title: "concert",
        price: 20
    });
    await ticket.save();

    const userOne = global.signin();
    const userTwo = global.signin();

    const [res1, res2] = await Promise.all([
        request(app)
            .post("/api/orders")
            .set("Cookie", userOne)
            .send({ ticketId: ticket.id }),
        request(app)
            .post("/api/orders")
            .set("Cookie", userTwo)
            .send({ ticketId: ticket.id })
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([201, 400]);
});