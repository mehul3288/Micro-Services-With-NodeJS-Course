import "./tracing";
import mongoose from "mongoose";
import { app } from "./app";
import { kafkaWrapper } from "./kafka-wrapper";
import {
    registerGracefulShutdown,
    ensureTopics,
    EventConsumer,
    OutboxRelay,
    createLogger,
} from "@mehul-mrtickets/common";
import { OrderCreatedListener } from "./events/listeners/order-created-listener";
import { OrderCancelledListener } from "./events/listeners/order-cancelled-listener";

const logger = createLogger("tickets");

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
        await mongoose.connect(process.env.MONGO_URI);
        logger.info("Connected to MongoDB");

        const brokers = process.env.KAFKA_BROKERS.split(",");
        await kafkaWrapper.connect(process.env.KAFKA_CLIENT_ID, brokers);
        await ensureTopics(kafkaWrapper.kafka);

        const consumer = new EventConsumer(kafkaWrapper.kafka, "tickets-service", {
            deduplicate: true,
            connection: mongoose.connection,
        });
        consumer.register(new OrderCreatedListener());
        consumer.register(new OrderCancelledListener());
        await consumer.start();

        const outboxRelay = new OutboxRelay(kafkaWrapper.producer, {
            serviceName: "tickets",
        });
        outboxRelay.start();

        const server = app.listen(3000, () => {
            logger.info("Server is running on port 3000");
        });

        registerGracefulShutdown(server, [
            async () => {
                outboxRelay.stop();
            },
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
    } catch (e: any) {
        logger.error({ err: e.message }, "Failed to start tickets service");
        process.exit(1);
    }
};

start();
