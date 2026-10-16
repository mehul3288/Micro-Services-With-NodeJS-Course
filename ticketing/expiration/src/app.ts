import express from "express";
import {
    healthRouter,
    shutdownState,
    createHttpLogger,
    metricsMiddleware,
    metricsRouter,
} from "@mehul-mrtickets/common";
import { kafkaWrapper } from "./kafka-wrapper";

const app = express();

// Observability: Metrics and HTTP request logger
app.use(metricsMiddleware);
app.use(metricsRouter);
if (process.env.NODE_ENV !== "test") {
    app.use(createHttpLogger("expiration"));
}

app.use(
    healthRouter([
        () => kafkaWrapper.isConnected,
        () => !shutdownState.isShuttingDown,
    ])
);

export { app };
