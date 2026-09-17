import request from "supertest";
import { app } from "../../app";

it("User signin with valid credentials", async () => {
    await request(app)
        .post('/api/users/signup')
        .send({
            email: "test@test.com",
            password: "password"
        }).expect(201)

    const response = await request(app)
        .post('/api/users/signin')
        .send({
            email: "test@test.com",
            password: "password"
        }).expect(200);

    expect(response.get("Set-Cookie")).toBeDefined();
})

it("fails when a email that does not exist is supplied", async () => {
    await request(app)
        .post("/api/users/signin")
        .send({
            email: "test@test.com",
            password: "pass"
        }).expect(400)
});

it("fails when a password that does not match is supplied", async () => {
    await request(app)
        .post('/api/users/signup')
        .send({
            email: "test@test.com",
            password: "password"
        }).expect(201)

    await request(app)
        .post('/api/users/signin')
        .send({
            email: "test@test.com",
            password: "wrongpassword"
        }).expect(400);
})