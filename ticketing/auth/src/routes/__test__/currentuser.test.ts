import request from "supertest";
import { app } from "../../app";

it("responds with details about the current user", async () => {
    // instead of repeatedly writing this signup code we use global.signin we have declared this in setup.ts file
    // const response1 = await request(app)
    //     .post("/api/users/signup")
    //     .send({
    //         email: "test@test.com",
    //         password: "password"
    //     }).expect(201);
    // const cookies = response1.get("Set-Cookie");
    // if (!cookies) {
    //     throw new Error("Expected cookie but got undefined.");
    // }
    const cookies = await global.signin();
    const response = await request(app)
        .get("/api/users/currentuser")
        .set("Cookie", cookies)
        .expect(200);

    expect(response.body.currentUser.email).toEqual("test@test.com");
})

it("responds with null when not authenticated", async () => {
    const cookies = await global.signin();

    const response = await request(app)
        .post("/api/users/signout")
        .set("Cookie", cookies)
        .send({})
        .expect(200);

    const cookie = response.get("Set-Cookie");
    if (!cookie) {
        throw new Error("Expected cookie but got undefined.");
    }

    expect(cookie[0]).toEqual(
        "session=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; httponly"
    );

    const response1 = await request(app)
        .get("/api/users/currentuser")
        .set("Cookie", cookie)
        .expect(200);

    expect(response1.body.currentUser).toBeNull();

})