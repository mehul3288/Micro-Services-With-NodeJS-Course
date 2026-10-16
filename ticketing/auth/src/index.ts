import "./tracing";
import mongoose from "mongoose";
import { app } from "./app";
import { registerGracefulShutdown, createLogger } from "@mehul-mrtickets/common";

const logger = createLogger("auth");

const start = async () => {
    if (!process.env.JWT_KEY) {
        throw new Error("JWT_KEY not defined");
    }
    if (!process.env.MONGO_URI) {
        throw new Error("MONGO_URI not defined");
    }
    try {
        await mongoose.connect(process.env.MONGO_URI);
        logger.info("Connected to MongoDB");

        const server = app.listen(3000, () => {
            logger.info("Server is running on port 3000");
        });

        registerGracefulShutdown(server, [
            async () => {
                await mongoose.disconnect();
            },
        ]);
    } catch (e: any) {
        logger.error({ err: e.message }, "Failed to start auth service");
        process.exit(1);
    }
};

start();
