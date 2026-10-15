import express from "express";
import { json } from "body-parser";
import mongoose from "mongoose";
import { currentUser, errorHandler, NotFoundError, healthRouter, shutdownState } from "@mehul-mrtickets/common";
import cookieSession from "cookie-session";
import { kafkaWrapper } from "./kafka-wrapper";
import { newOrderRouter } from "./routes/new";
import { showOrderRouter } from "./routes/show";
import { indexOrderRouter } from "./routes";
import { deleteOrderRouter } from "./routes/delete";

const app = express();
app.use(json());
app.set("trust proxy", true);
app.use(cookieSession({
    signed: false,
    secure: process.env.NODE_ENV !== "test"
}));

app.use(healthRouter([
    () => mongoose.connection.readyState === 1,
    () => kafkaWrapper.isConnected,
    () => !shutdownState.isShuttingDown
]));

app.use(currentUser);
app.use(newOrderRouter);
app.use(showOrderRouter);
app.use(indexOrderRouter);
app.use(deleteOrderRouter);

app.all("*splat", async () => {
    throw new NotFoundError();
});

app.use(errorHandler);

export { app };