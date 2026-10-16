import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import jwt from "jsonwebtoken";

declare global {
    var signin: (id?: string) => string[];
}

let mongo: MongoMemoryServer;
let dbPath: string;
jest.setTimeout(60000);

jest.mock("../kafka-wrapper");
jest.mock("../stripe");

beforeAll(async () => {
    process.env.JWT_KEY = "asdf";

    dbPath = path.join(process.cwd(), ".tmp-mongo", Math.random().toString(36).substring(7));
    fs.mkdirSync(dbPath, { recursive: true });

    mongo = await MongoMemoryServer.create({
        instance: {
            dbPath,
            args: ["--replSet", "rs0"],
            storageEngine: "wiredTiger",
        },
        binary: {
            version: "7.0.8",
        },
    });

    const uri = mongo.getUri();
    const port = mongo.instanceInfo!.port;

    // @ts-ignore
    await mongoose.connect(`${uri}?replicaSet=rs0&directConnection=true`, {
        // @ts-ignore
        runtimeAdapters: { os },
    });

    // Initiate single-node replica set for transaction support
    try {
        await mongoose.connection.db!.admin().command({
            replSetInitiate: {
                _id: "rs0",
                members: [{ _id: 0, host: `127.0.0.1:${port}` }],
            },
        });
        await new Promise((r) => setTimeout(r, 1000));
    } catch (e: any) {
        if (!e.message?.includes("already initialized")) {
            throw e;
        }
    }
}, 60000);

beforeEach(async () => {
    jest.clearAllMocks();
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


global.signin = (id?: string) => {
    //Build a JWT payload. {id,email}
    const payload = {
        id: id || new mongoose.Types.ObjectId().toHexString(),
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
