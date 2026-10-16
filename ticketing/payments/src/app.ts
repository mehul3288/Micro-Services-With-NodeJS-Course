import express from "express";
import { json } from "body-parser";
import mongoose from "mongoose";
import {
    currentUser,
    errorHandler,
    NotFoundError,
    healthRouter,
    shutdownState,
    createHttpLogger,
    metricsMiddleware,
    metricsRouter,
} from "@mehul-mrtickets/common";
import cookieSession from "cookie-session";
import { kafkaWrapper } from "./kafka-wrapper";
import { createPaymentRouter } from "./routes/new";

const app = express();
app.use(json());
app.set("trust proxy", true);
app.use(cookieSession({
    signed: false,
    secure: process.env.NODE_ENV !== "test"
}));

// Observability: Metrics and HTTP request logger
app.use(metricsMiddleware);
app.use(metricsRouter);
if (process.env.NODE_ENV !== "test") {
    app.use(createHttpLogger("payments"));
}

app.use(healthRouter([
    () => mongoose.connection.readyState === 1,
    () => kafkaWrapper.isConnected,
    () => !shutdownState.isShuttingDown
]));

app.use(currentUser);
app.use(createPaymentRouter);

app.all("*splat", async () => {
    throw new NotFoundError();
});

app.use(errorHandler);

export { app };