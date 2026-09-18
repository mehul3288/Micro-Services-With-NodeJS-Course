import express from "express";
import { json } from "body-parser";
import { currentUser, errorHandler, NotFoundError } from "@mehul-mrtickets/common";
import cookieSession from "cookie-session";
import { createTicketRouter } from "./routes/new";
import { showTicketRouter } from "./routes/show";
import { indexTicketRouter } from "./routes";
import { updateTicketRouter } from "./routes/update";

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
app.use(createTicketRouter)
app.use(showTicketRouter)
app.use(indexTicketRouter)
app.use(updateTicketRouter)


app.all("*splat", async () => {
    throw new NotFoundError()
})

app.use(errorHandler);

export { app }