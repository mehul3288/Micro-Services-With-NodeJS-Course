import express from "express";
import { json } from "body-parser";
import mongoose from "mongoose";
import { currentUserRouter } from "./routes/current-user";
import { signinRouter } from "./routes/signin";
import { signoutRouter } from "./routes/signout";
import { signupRouter } from "./routes/signup";
import {
    errorHandler,
    NotFoundError,
    healthRouter,
    shutdownState,
    createHttpLogger,
    metricsMiddleware,
    metricsRouter,
} from "@mehul-mrtickets/common";
import cookieSession from "cookie-session";

const app = express();
app.use(json());
app.set("trust proxy", true);
app.use(
    cookieSession({
        signed: false,
        secure: process.env.NODE_ENV !== "test",
    })
);

// Observability: Metrics and HTTP request logger
app.use(metricsMiddleware);
app.use(metricsRouter);
if (process.env.NODE_ENV !== "test") {
    app.use(createHttpLogger("auth"));
}

app.use(
    healthRouter([
        () => mongoose.connection.readyState === 1,
        () => !shutdownState.isShuttingDown,
    ])
);

app.use(currentUserRouter);
app.use(signinRouter);
app.use(signoutRouter);
app.use(signupRouter);

app.all("*splat", async () => {
    throw new NotFoundError();
});

app.use(errorHandler);

export { app };