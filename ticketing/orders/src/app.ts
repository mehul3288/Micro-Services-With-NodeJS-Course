import express from "express";
import { json } from "body-parser";
import { currentUser, errorHandler, NotFoundError } from "@mehul-mrtickets/common";
import cookieSession from "cookie-session";
import { newOrderRouter } from "./routes/new";
import { showOrderRouter } from "./routes/show";
import { indexOrderRouter } from "./routes";
import { deleteOrderRouter } from "./routes/delete";

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
app.use(newOrderRouter)
app.use(showOrderRouter)
app.use(indexOrderRouter)
app.use(deleteOrderRouter)


app.all("*splat", async () => {
    throw new NotFoundError()
})

app.use(errorHandler);

export { app }