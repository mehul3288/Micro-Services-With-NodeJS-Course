import request from "supertest";
import { app } from "../../app";
import mongoose from "mongoose";
import { Order } from "../../models/order";
import { OrderStatus } from "@mehul-mrtickets/common";
import { stripe } from "../../stripe";
import { Payment } from "../../models/payment";

jest.mock("../../stripe");

it("returns a 404 when an order that does not exist is purchased", async () => {
    await request(app)
        .post("/api/payments")
        .set("Cookie", global.signin())
        .send({
            token: "alskjdfa",
            orderId: new mongoose.Types.ObjectId().toHexString()
        })
        .expect(404);
});

it("returns a 400 when orderId is not a valid Mongo ID", async () => {
    await request(app)
        .post("/api/payments")
        .set("Cookie", global.signin())
        .send({
            token: "alskjdfa",
            orderId: "invalid-id-123"
        })
        .expect(400);
});

it("returns a 401 when the order does not belong to the user", async () => {
    const order = Order.build({
        id: new mongoose.Types.ObjectId().toHexString(),
        version: 0,
        userId: new mongoose.Types.ObjectId().toHexString(),
        price: 20,
        status: OrderStatus.Created
    });

    await order.save();

    await request(app)
        .post("/api/payments")
        .set("Cookie", global.signin())
        .send({
            token: "alskdfjl",
            orderId: order.id
        })
        .expect(401);
});

it("returns a 400 when the order is already cancelled", async () => {
    const userId = new mongoose.Types.ObjectId().toHexString();
    const cookie = global.signin(userId);
    const order = Order.build({
        id: new mongoose.Types.ObjectId().toHexString(),
        version: 0,
        userId: userId,
        price: 20,
        status: OrderStatus.Cancelled
    });

    await order.save();

    await request(app)
        .post("/api/payments")
        .set("Cookie", cookie)
        .send({
            token: "alskdfjl",
            orderId: order.id
        })
        .expect(400);
});

it("returns 201 with valid inputs and passes idempotency key to Stripe", async () => {
    const userId = new mongoose.Types.ObjectId().toHexString();
    const cookie = global.signin(userId);
    const order = Order.build({
        id: new mongoose.Types.ObjectId().toHexString(),
        version: 0,
        userId: userId,
        price: 19.99,
        status: OrderStatus.Created
    });

    await order.save();

    await request(app)
        .post("/api/payments")
        .set("Cookie", cookie)
        .send({
            token: "tok_visa",
            orderId: order.id
        })
        .expect(201);

    const chargeParams = (stripe.charges.create as jest.Mock).mock.calls[0][0];
    const chargeOptions = (stripe.charges.create as jest.Mock).mock.calls[0][1];

    expect(chargeParams.source).toEqual("tok_visa");
    // Verify rounding
    expect(chargeParams.amount).toEqual(Math.round(19.99 * 100));
    expect(chargeParams.currency).toEqual("usd");
    // Verify idempotencyKey
    expect(chargeOptions.idempotencyKey).toEqual(`charge-${order.id}`);

    const payment = await Payment.findOne({ orderId: order.id });
    expect(payment).not.toBeNull();
});

it("returns 400 when an already paid order is charged a second time", async () => {
    const userId = new mongoose.Types.ObjectId().toHexString();
    const cookie = global.signin(userId);
    const order = Order.build({
        id: new mongoose.Types.ObjectId().toHexString(),
        version: 0,
        userId: userId,
        price: 20,
        status: OrderStatus.Created
    });

    await order.save();

    // First payment succeeds
    await request(app)
        .post("/api/payments")
        .set("Cookie", cookie)
        .send({
            token: "tok_visa",
            orderId: order.id
        })
        .expect(201);

    // Second payment fails with 400
    const res = await request(app)
        .post("/api/payments")
        .set("Cookie", cookie)
        .send({
            token: "tok_visa",
            orderId: order.id
        })
        .expect(400);

    expect(res.body.errors[0].message).toEqual("Order is already paid");
});