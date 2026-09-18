import request from "supertest";
import { app } from "../../app";
import mongoose from "mongoose";

it("returns a 404 if the ticket is not found", async () => {
    //This can be added to helper function so this is one use case we can tell in interview about what you put inside helper function or utilities
    const id = new mongoose.Types.ObjectId().toHexString()
    await request(app)
        .get(`/api/tickets/${id}`)
        .send()
        .expect(404);
})

it("returns the ticket if the ticket is found", async () => {
    // const id = "abc"
    // await request(app)
    //     .get(`/api/tickets/${id}`)
    //     .send()
    //     .expect(200);
    const title = "Concert";
    const price = 20;
    const response = await request(app)
        .post("/api/tickets")
        .set("Cookie", global.signin())
        .send({
            title,
            price
        }).expect(201)

    const id = response.body.id;

    const ticketResponse = await request(app)
        .get("/api/tickets/" + id)
        .expect(200)

    expect(ticketResponse.body.title).toEqual(title);
    expect(ticketResponse.body.price).toEqual(price);
})