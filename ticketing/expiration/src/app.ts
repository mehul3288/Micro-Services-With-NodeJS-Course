import express from "express";
import { healthRouter, shutdownState } from "@mehul-mrtickets/common";
import { kafkaWrapper } from "./kafka-wrapper";

const app = express();

app.use(
    healthRouter([
        () => kafkaWrapper.isConnected,
        () => !shutdownState.isShuttingDown,
    ])
);

export { app };
