import mongoose from "mongoose";
import { app } from "./app";
import { registerGracefulShutdown } from "@mehul-mrtickets/common";

const start = async () => {
    if (!process.env.JWT_KEY) {
        throw new Error("JWT_KEY not defined");
    }
    if (!process.env.MONGO_URI) {
        throw new Error("MONGO_URI not defined");
    }
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log("Connected to Mongo!!!");

        const server = app.listen(3000, () => {
            console.log("Server is running at port 3000!!!!");
        });

        registerGracefulShutdown(server, [
            async () => {
                await mongoose.disconnect();
            }
        ]);
    } catch (e) {
        console.error("Failed to start auth service:", e);
        process.exit(1);
    }
};

start();
