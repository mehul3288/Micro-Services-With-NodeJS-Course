import mongoose from "mongoose";
import { app } from "./app";
import { natsWrapper } from "./nats-wrapper";
import { registerGracefulShutdown } from "@mehul-mrtickets/common";
import { TicketCreatedListener } from "./events/listeners/ticket-created-listener";
import { TicketUpdatedListener } from "./events/listeners/ticket-updated-listener";
import { ExpirationCompleteListener } from "./events/listeners/expiration-complete-listener";
import { PaymentCreatedListener } from "./events/listeners/payment-created-listener";

const start = async () => {
    if (!process.env.JWT_KEY) {
        throw new Error("JWT_KEY not defined");
    }
    if (!process.env.MONGO_URI) {
        throw new Error("MONGO_URI not defined");
    }
    if (!process.env.NATS_CLUSTER_ID) {
        throw new Error("NATS_CLUSTER_ID not defined");
    }
    if (!process.env.NATS_CLIENT_ID) {
        throw new Error("NATS_CLIENT_ID not defined");
    }
    if (!process.env.NATS_URL) {
        throw new Error("NATS_URL not defined");
    }
    try {
        await natsWrapper.connect(process.env.NATS_CLUSTER_ID, process.env.NATS_CLIENT_ID, process.env.NATS_URL);
        await mongoose.connect(process.env.MONGO_URI);
        console.log("Connected to Mongo!!!");

        new TicketCreatedListener(natsWrapper.client).listen();
        new TicketUpdatedListener(natsWrapper.client).listen();
        new ExpirationCompleteListener(natsWrapper.client).listen();
        new PaymentCreatedListener(natsWrapper.client).listen();

        const server = app.listen(3000, () => {
            console.log("Server is running at port 3000!!!!");
        });

        registerGracefulShutdown(server, [
            async () => {
                natsWrapper.client.close();
            },
            async () => {
                await mongoose.disconnect();
            }
        ]);
    } catch (e) {
        console.error("Failed to start orders service:", e);
        process.exit(1);
    }
};

start();
