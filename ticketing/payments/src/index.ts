import "./tracing";
import mongoose from "mongoose";
import { app } from "./app";
import { kafkaWrapper } from "./kafka-wrapper";
import { registerGracefulShutdown, ensureTopics, EventConsumer, OutboxRelay, createLogger, schemaRegistry } from "@mehul-mrtickets/common";
import { OrderCancelledListener } from "./events/listeners/order-cancelled-listener";
import { OrderCreatedListener } from "./events/listeners/order-created-listener";
import { RefundRequestedListener } from "./events/listeners/refund-requested-listener";

const logger = createLogger("payments");

const start = async () => {
    if (!process.env.JWT_KEY) {
        throw new Error("JWT_KEY not defined");
    }
    if (!process.env.MONGO_URI) {
        throw new Error("MONGO_URI not defined");
    }
    if (!process.env.STRIPE_KEY) {
        throw new Error("STRIPE_KEY not defined");
    }
    if (!process.env.KAFKA_BROKERS) {
        throw new Error("KAFKA_BROKERS not defined");
    }
    if (!process.env.KAFKA_CLIENT_ID) {
        throw new Error("KAFKA_CLIENT_ID not defined");
    }

    try {
        await mongoose.connect(process.env.MONGO_URI);
        logger.info("Connected to Mongo");

        const brokers = process.env.KAFKA_BROKERS.split(",");
        await kafkaWrapper.connect(process.env.KAFKA_CLIENT_ID, brokers);
        await ensureTopics(kafkaWrapper.kafka);
        await schemaRegistry.init();

        const outboxRelay = new OutboxRelay(kafkaWrapper.producer, {
            pollIntervalMs: 200,
            batchSize: 50,
        });
        outboxRelay.start();

        const consumer = new EventConsumer(kafkaWrapper.kafka, "payments-service", {
            deduplicate: true,
            connection: mongoose.connection,
        });
        consumer.register(new OrderCreatedListener());
        consumer.register(new OrderCancelledListener());
        consumer.register(new RefundRequestedListener());
        await consumer.start();

        const server = app.listen(3000, () => {
            logger.info("Server is running at port 3000");
        });

        registerGracefulShutdown(server, [
            async () => {
                await outboxRelay.stop();
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
    } catch (e) {
        logger.error({ err: e }, "Failed to start payments service");
        process.exit(1);
    }
};

start();
