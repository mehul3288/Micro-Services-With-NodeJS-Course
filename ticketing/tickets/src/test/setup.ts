import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { app } from "../app";
import * as os from "os";
import request from "supertest";
import jwt from "jsonwebtoken";

declare global {
    var signin: () => string[];
}

let mongo: MongoMemoryServer;
jest.setTimeout(30000);

beforeAll(async () => {
    process.env.JWT_KEY = "asdf";
    mongo = await MongoMemoryServer.create({
        binary: {
            version: "7.0.8"
        }
    });
    const mongoUri = mongo.getUri();

    // @ts-ignore
    await mongoose.connect(mongoUri, {
        // @ts-ignore
        runtimeAdapters: { os }
    });
}, 60000);

beforeEach(async () => {
    if (mongoose.connection.db) {
        const collections = await mongoose.connection.db.collections();

        for (let collection of collections) {
            await collection.deleteMany({});
        }
    }
});

afterAll(async () => {
    await mongoose.connection.close();
    if (mongo) {
        await mongo.stop();
    }
});


global.signin = () => {
    //Build a JWT payload. {id,email}
    const payload = {
        id: new mongoose.Types.ObjectId().toHexString(),
        email: "test@test.com"
    }

    //Create the JWT!

    const token = jwt.sign(payload, process.env.JWT_KEY!);
    //Build session object {jwt: MY_JWT}
    const session = {
        jwt: token
    }

    //Turn that session into JSON
    const sessionJSON = JSON.stringify(session)

    //Take JSON and encode them in Base64
    const base64 = Buffer.from(sessionJSON).toString("base64")

    //return a string thats the cookie with the encoded data
    return [`session=${base64}`];
}
