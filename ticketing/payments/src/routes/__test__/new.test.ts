import request from "supertest"
import { app } from "../../app";
import mongoose from "mongoose";
import { Order } from "../../models/order";
import { OrderStatus } from "@mehul-mrtickets/common";
import { stripe } from "../../stripe";
import { Payment } from "../../models/payment";

// jest.mock("../../stripe")



it("returns a 404 when a ticket that does not exist is purchased", async () => {
    await request(app)
        .post("/api/payments")
        .set("Cookie", global.signin())
        .send({
            token: "alskjdfa",
            orderId: new mongoose.Types.ObjectId().toHexString()
        })
        .expect(404)
})

it("returns a 401 when the order does not belong to the user", async () => {
    const order = Order.build({
        id: new mongoose.Types.ObjectId().toHexString(),
        version: 0,
        userId: new mongoose.Types.ObjectId().toHexString(),
        price: 20,
        status: OrderStatus.Created
    })

    await order.save();

    await request(app)
        .post("/api/payments")
        .set("Cookie", global.signin())
        .send({
            token: "alskdfjl",
            orderId: order._id.toHexString()
        })
        .expect(401)
})

it("returns a 400 when the order is already cancelled", async () => {
    const userId = new mongoose.Types.ObjectId().toHexString();
    const cookie = global.signin(userId);
    const order = Order.build({
        id: new mongoose.Types.ObjectId().toHexString(),
        version: 0,
        userId: userId,
        price: 20,
        status: OrderStatus.Cancelled
    })

    await order.save();

    await request(app)
        .post("/api/payments")
        .set("Cookie", cookie)
        .send({
            token: "alskdfjl",
            orderId: order._id.toHexString()
        })
        .expect(400)
})

//This is with the mock function
// it("returns 201 with valid inputs", async () => {
//     const userId = new mongoose.Types.ObjectId().toHexString();
//     const cookie = global.signin(userId);
//     const order = Order.build({
//         id: new mongoose.Types.ObjectId().toHexString(),
//         version: 0,
//         userId: userId,
//         price: 20,
//         status: OrderStatus.Created
//     })

//     await order.save();

//     await request(app)
//         .post("/api/payments")
//         .set("Cookie", cookie)
//         .send({
//             token: "tok_visa",
//             orderId: order._id.toHexString()
//         })
//         .expect(201)

//     const chargeOptions = ((stripe.charges.create as jest.Mock).mock.calls[0][0]);
//     expect(chargeOptions.source).toEqual("tok_visa")
//     expect(chargeOptions.amount).toEqual(20 * 100)
//     expect(chargeOptions.currency).toEqual("usd")

// })


it("returns 201 with valid inputs", async () => {
    const userId = new mongoose.Types.ObjectId().toHexString();
    const cookie = global.signin(userId);
    const price = Math.floor(Math.random() * 100000);
    const order = Order.build({
        id: new mongoose.Types.ObjectId().toHexString(),
        version: 0,
        userId: userId,
        price: price,
        status: OrderStatus.Created
    })

    await order.save();

    await request(app)
        .post("/api/payments")
        .set("Cookie", cookie)
        .send({
            token: "tok_visa",
            orderId: order._id.toHexString()
        })
        .expect(201)

    const stripCharges = await stripe.charges.list({ limit: 50 })
    const charge = stripCharges.data.find((charge) => {
        return charge.amount === price * 100
    })

    const payment = await Payment.findOne({
        orderId: order._id.toHexString(),
        stripeId: charge?.id
    })

    expect(charge).toBeDefined();
    expect(charge?.currency).toEqual("usd");

    expect(payment).not.toBeNull();
    expect(payment?.stripeId).toEqual(charge?.id);

})