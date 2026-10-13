import request from "supertest";
import { app } from "../../app";
import { Ticket } from "../../models/ticket";
import { Order, OrderStatus } from "../../models/order";
import mongoose from "mongoose";
import { natsWrapper } from "../../nats-wrapper";

it("returns 404 if the order is not found", async () => {
    const id = new mongoose.Types.ObjectId().toHexString();
    await request(app)
        .delete(`/api/orders/${id}`)
        .set("Cookie", global.signin())
        .expect(404);
});

it("marks an order as cancelled and releases the ticket", async () => {
    const ticket = Ticket.build({
        id: new mongoose.Types.ObjectId().toHexString(),
        title: "Concert",
        price: 111
    });
    await ticket.save();

    const user = global.signin();

    const { body: order } = await request(app)
        .post("/api/orders")
        .set("Cookie", user)
        .send({ ticketId: ticket.id })
        .expect(201);

    // Verify ticket was reserved
    let ticketInDb = await Ticket.findById(ticket.id);
    expect(ticketInDb?.reservedBy).toEqual(order.id);

    await request(app)
        .delete(`/api/orders/${order.id}`)
        .set("Cookie", user)
        .expect(204);

    const updatedOrder = await Order.findById(order.id);
    expect(updatedOrder?.status).toEqual(OrderStatus.Cancelled);

    // Verify ticket reservation was released
    ticketInDb = await Ticket.findById(ticket.id);
    expect(ticketInDb?.reservedBy).toBeNull();
});

it("emits an order cancelled event", async () => {
    const ticket = Ticket.build({
        id: new mongoose.Types.ObjectId().toHexString(),
        title: "Concert",
        price: 111
    });
    await ticket.save();

    const user = global.signin();

    const { body: order } = await request(app)
        .post("/api/orders")
        .set("Cookie", user)
        .send({ ticketId: ticket.id })
        .expect(201);

    await request(app)
        .delete(`/api/orders/${order.id}`)
        .set("Cookie", user)
        .expect(204);

    expect(natsWrapper.client.publish).toHaveBeenCalled();
});

it("rejects cancellation of an already completed order with 400", async () => {
    const ticket = Ticket.build({
        id: new mongoose.Types.ObjectId().toHexString(),
        title: "Concert",
        price: 111
    });
    await ticket.save();

    const user = global.signin();

    const { body: order } = await request(app)
        .post("/api/orders")
        .set("Cookie", user)
        .send({ ticketId: ticket.id })
        .expect(201);

    // Mark order as Complete
    await Order.findByIdAndUpdate(order.id, { status: OrderStatus.Complete });

    await request(app)
        .delete(`/api/orders/${order.id}`)
        .set("Cookie", user)
        .expect(400);
});

it("is idempotent when cancelling an already cancelled order", async () => {
    const ticket = Ticket.build({
        id: new mongoose.Types.ObjectId().toHexString(),
        title: "Concert",
        price: 111
    });
    await ticket.save();

    const user = global.signin();

    const { body: order } = await request(app)
        .post("/api/orders")
        .set("Cookie", user)
        .send({ ticketId: ticket.id })
        .expect(201);

    // First cancel -> 204
    await request(app)
        .delete(`/api/orders/${order.id}`)
        .set("Cookie", user)
        .expect(204);

    // Clear publish mock
    (natsWrapper.client.publish as jest.Mock).mockClear();

    // Second cancel -> 204 without republishing
    await request(app)
        .delete(`/api/orders/${order.id}`)
        .set("Cookie", user)
        .expect(204);

    expect(natsWrapper.client.publish).not.toHaveBeenCalled();
});