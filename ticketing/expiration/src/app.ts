import express from "express";
import { healthRouter, shutdownState } from "@mehul-mrtickets/common";
import { natsWrapper } from "./nats-wrapper";

const app = express();

app.use(healthRouter([
    () => natsWrapper.isConnected,
    () => !shutdownState.isShuttingDown
]));

export { app };
