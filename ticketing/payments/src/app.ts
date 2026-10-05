import express from "express";
import { json } from "body-parser";
import { currentUser, errorHandler, NotFoundError } from "@mehul-mrtickets/common";
import cookieSession from "cookie-session";
import { createPaymentRouter } from "./routes/new";


const app = express();
app.use(json());
app.set("trust proxy", true);
app.use(cookieSession({
    //not encrypted
    signed: false,
    //will run on https only
    secure: process.env.NODE_ENV !== "test"
}))
app.use(currentUser)
app.use(createPaymentRouter)


app.all("*splat", async () => {
    throw new NotFoundError()
})

app.use(errorHandler);

export { app }