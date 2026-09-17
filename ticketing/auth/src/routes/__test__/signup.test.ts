import request from "supertest";
import { app } from "../../app";

it("Returns a 201 on successful signup", async () => {
    return request(app)
        .post('/api/users/signup')
        .send({
            email: 'test@test.com',
            password: 'password'
        })
        .expect(201);
})

it("Returns a 400 with an invalid email", async () => {
    return request(app)
        .post('/api/users/signup')
        .send({
            email: 'test@testcom',
            password: 'password'
        })
        .expect(400);
})

it("Returns a 400 with an invalid password", async () => {
    return request(app)
        .post('/api/users/signup')
        .send({
            email: 'test@test.com',
            password: '123'
        })
        .expect(400);
})

it("Returns a 400 with missing email and password", async () => {
    return request(app)
        .post('/api/users/signup')
        .send({})
        .expect(400);
})

it("disallows duplicate emails", async () => {
    await request(app)
        .post('/api/users/signup')
        .send({
            email: 'test@test.com',
            password: 'password'
        })
        .expect(201);

    await request(app)
        .post('/api/users/signup')
        .send({
            email: 'test@test.com',
            password: 'password'
        })
        .expect(400);
})

it("sets a cookie after successful signup", async () => {
    //First time our request was failing because we have use secure:true in cookie-session
    //But in our test environemnt we are not using https
    //So we need to set secure:false or we can set secure:process.env_NODE_ENV!=="test" for test environment
    const response = await request(app)
        .post('/api/users/signup')
        .send({
            email: 'test@test.com',
            password: 'password'
        })
        .expect(201);
    expect(response.get("Set-Cookie")).toBeDefined();
})