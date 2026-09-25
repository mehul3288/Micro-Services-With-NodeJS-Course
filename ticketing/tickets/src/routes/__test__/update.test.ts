import request from "supertest";
import { app } from "../../app";
import mongoose from "mongoose";
import { natsWrapper } from "../../nats-wrapper";

it("returns a 404 if the provided id does not exist", async () => {
    const id = new mongoose.Types.ObjectId().toHexString();
    await request(app)
        .put(`/api/tickets/${id}`)
        .set("Cookie", global.signin())
        .send({
            title: "abcd",
            price: 20
        })
        .expect(404);
});

it("returns a 401 if the user is not authenticated", async () => {
    const id = new mongoose.Types.ObjectId().toHexString();
    await request(app)
        .put(`/api/tickets/${id}`)
        .send({
            title: "abcd",
            price: 20
        })
        .expect(401);
});

it("returns a 401 if the user does not own a ticket", async () => {
    const response = await request(app)
        .post("/api/tickets")
        .set("Cookie", global.signin())
        .send({
            title: "ticket1",
            price: 20
        })
        .expect(201)

    await request(app)
        .put(`/api/tickets/${response.body.id}`)
        .set("Cookie", global.signin())
        .send({
            title: "abcd",
            price: 20
        })
        .expect(401);
});

it("returns a 400 if the user provides an invalid title or price", async () => {
    const cookie = global.signin();
    const response = await request(app)
        .post("/api/tickets")
        .set("Cookie", cookie)
        .send({
            title: "ticket1",
            price: 20
        })
        .expect(201)

    await request(app)
        .put(`/api/tickets/${response.body.id}`)
        .set("Cookie", cookie)
        .send({
            title: "",
            price: 20
        })
        .expect(400);

    await request(app)
        .put(`/api/tickets/${response.body.id}`)
        .set("Cookie", cookie)
        .send({
            title: "abcd",
            price: -20
        })
        .expect(400);

});

it("updates the ticket provided valid inputs", async () => {
    const cookie = global.signin();
    const response = await request(app)
        .post("/api/tickets")
        .set("Cookie", cookie)
        .send({
            title: "ticket1",
            price: 20
        })
        .expect(201)

    await request(app)
        .put(`/api/tickets/${response.body.id}`)
        .set("Cookie", cookie)
        .send({
            title: "abcd",
            price: 100
        })
        .expect(200)

    const ticketResponse = await request(app)
        .get(`/api/tickets/${response.body.id}`)
        .expect(200);

    expect(ticketResponse.body.title).toEqual("abcd");
    expect(ticketResponse.body.price).toEqual(100);
});


it("publishes an event", async () => {
    const cookie = global.signin();
    const response = await request(app)
        .post("/api/tickets")
        .set("Cookie", cookie)
        .send({
            title: "ticket1",
            price: 20
        })
        .expect(201)

    await request(app)
        .put(`/api/tickets/${response.body.id}`)
        .set("Cookie", cookie)
        .send({
            title: "abcd",
            price: 100
        })
        .expect(200);

    expect(natsWrapper.client.publish).toHaveBeenCalled();
})