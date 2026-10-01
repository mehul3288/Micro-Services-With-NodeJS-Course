import request from "supertest";
import { app } from "../../app";
import { Ticket } from "../../models/ticket";
import { Order } from "../../models/order";
import { OrderStatus } from "../../models/order";
import mongoose from "mongoose";
import { natsWrapper } from "../../nats-wrapper";

it("returns 404 if the order is not found", async () => {
    const id = new mongoose.Types.ObjectId().toHexString();
    await request(app)
        .delete(`/api/orders/${id}`)
        .set("Cookie", global.signin())
        .expect(404);
});

it("marks an order as cancelled", async () => {
    const ticket = Ticket.build({
        id: new mongoose.Types.ObjectId().toHexString(),
        title: "Concert",
        price: 111
    })

    await ticket.save();

    const user = global.signin();

    const { body: order } = await request(app)
        .post("/api/orders")
        .set('Cookie', user)
        .send({ ticketId: ticket._id })
        .expect(201);

    await request(app)
        .delete(`/api/orders/${order.id}`)
        .set('Cookie', user)
        .expect(204);

    const updatedOrder = await Order.findById(order.id);

    expect(updatedOrder?.status).toEqual(OrderStatus.Cancelled)
})

it("emits an order cancelled event", async () => {
    const ticket = Ticket.build({
        id: new mongoose.Types.ObjectId().toHexString(),
        title: "Concert",
        price: 111
    })

    await ticket.save();

    const user = global.signin();

    const { body: order } = await request(app)
        .post("/api/orders")
        .set('Cookie', user)
        .send({ ticketId: ticket._id })
        .expect(201);

    await request(app)
        .delete(`/api/orders/${order.id}`)
        .set('Cookie', user)
        .expect(204);

    expect(natsWrapper.client.publish).toHaveBeenCalled();
})