import "./tracing";
import { app } from "./app";
import { OrderCreatedListener } from "./events/listeners/order-created-listener";
import { kafkaWrapper } from "./kafka-wrapper";
import { registerGracefulShutdown, ensureTopics, EventConsumer, createLogger } from "@mehul-mrtickets/common";

const logger = createLogger("expiration");

const start = async () => {
    if (!process.env.KAFKA_BROKERS) {
        throw new Error("KAFKA_BROKERS not defined");
    }
    if (!process.env.KAFKA_CLIENT_ID) {
        throw new Error("KAFKA_CLIENT_ID not defined");
    }
    if (!process.env.REDIS_HOST) {
        throw new Error("REDIS_HOST not defined");
    }

    try {
        const server = app.listen(3000, () => {
            logger.info("Expiration health server listening on port 3000");
        });

        const brokers = process.env.KAFKA_BROKERS.split(",");
        await kafkaWrapper.connect(process.env.KAFKA_CLIENT_ID, brokers);
        await ensureTopics(kafkaWrapper.kafka);

        const consumer = new EventConsumer(kafkaWrapper.kafka, "expiration-service");
        consumer.register(new OrderCreatedListener());
        await consumer.start();

        registerGracefulShutdown(server, [
            async () => {
                await consumer.disconnect();
            },
            async () => {
                await kafkaWrapper.disconnect();
            },
        ]);
    } catch (e) {
        logger.error({ err: e }, "Failed to start expiration service");
        process.exit(1);
    }
};

start();
