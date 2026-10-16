import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { app } from "../app";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import request from "supertest";

declare global {
    var signin: () => Promise<string[]>;
}

let mongo: MongoMemoryServer;
let dbPath: string;
jest.setTimeout(60000);

beforeAll(async () => {
    process.env.JWT_KEY = "asdf";

    dbPath = path.join(process.cwd(), ".tmp-mongo", Math.random().toString(36).substring(7));
    fs.mkdirSync(dbPath, { recursive: true });

    mongo = await MongoMemoryServer.create({
        instance: {
            dbPath,
            storageEngine: "wiredTiger",
        },
        binary: {
            version: "7.0.8",
        },
    });
    const mongoUri = mongo.getUri();

    // @ts-ignore
    await mongoose.connect(mongoUri, {
        // @ts-ignore
        runtimeAdapters: { os },
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
    if (dbPath && fs.existsSync(dbPath)) {
        try {
            fs.rmSync(dbPath, { recursive: true, force: true });
        } catch {}
    }
});

global.signin = async () => {
    const email = "test@test.com";
    const password = "password";

    const response = await request(app)
        .post("/api/users/signup")
        .send({
            email,
            password,
        })
        .expect(201);

    const cookie = response.get("Set-Cookie");
    if (!cookie) {
        throw new Error("No cookie returned");
    }
    return cookie;
};