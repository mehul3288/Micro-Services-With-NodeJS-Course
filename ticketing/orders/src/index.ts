import mongoose from "mongoose";
import { app } from "./app";
import { kafkaWrapper } from "./kafka-wrapper";
import { registerGracefulShutdown, ensureTopics, EventConsumer } from "@mehul-mrtickets/common";
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
    if (!process.env.KAFKA_BROKERS) {
        throw new Error("KAFKA_BROKERS not defined");
    }
    if (!process.env.KAFKA_CLIENT_ID) {
        throw new Error("KAFKA_CLIENT_ID not defined");
    }

    try {
        const brokers = process.env.KAFKA_BROKERS.split(",");
        await kafkaWrapper.connect(process.env.KAFKA_CLIENT_ID, brokers);
        await ensureTopics(kafkaWrapper.kafka);

        const consumer = new EventConsumer(kafkaWrapper.kafka, "orders-service");
        consumer.register(new TicketCreatedListener());
        consumer.register(new TicketUpdatedListener());
        consumer.register(new ExpirationCompleteListener());
        consumer.register(new PaymentCreatedListener());
        await consumer.start();

        await mongoose.connect(process.env.MONGO_URI);
        console.log("Connected to Mongo!!!");

        const server = app.listen(3000, () => {
            console.log("Server is running at port 3000!!!!");
        });

        registerGracefulShutdown(server, [
            async () => {
                await consumer.disconnect();
            },
            async () => {
                await kafkaWrapper.disconnect();
            },
            async () => {
                await mongoose.disconnect();
            },
        ]);
    } catch (e) {
        console.error("Failed to start orders service:", e);
        process.exit(1);
    }
};

start();
