import { app } from "./app";
import { OrderCreatedListener } from "./events/listeners/order-created-listener";
import { natsWrapper } from "./nats-wrapper";
import { registerGracefulShutdown } from "@mehul-mrtickets/common";

const start = async () => {
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

        new OrderCreatedListener(natsWrapper.client).listen();

        const server = app.listen(3000, () => {
            console.log("Expiration health server listening on port 3000");
        });

        registerGracefulShutdown(server, [
            async () => {
                natsWrapper.client.close();
            }
        ]);
    } catch (e) {
        console.error("Failed to start expiration service:", e);
        process.exit(1);
    }
};

start();
