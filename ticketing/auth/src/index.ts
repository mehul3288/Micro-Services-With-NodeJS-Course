import express from "express";
import { json } from "body-parser";
import { currentUserRouter } from "./routes/current-user";
import { signinRouter } from "./routes/signin";
import { signoutRouter } from "./routes/signout";
import { signupRouter } from "./routes/signup";
import { errorHandler } from "./middlewares/error-handler";
import { NotFoundError } from "./errors/not-found-error";
import mongoose from "mongoose";
import cookieSession from "cookie-session";

const app = express();
app.use(json());
app.set("trust proxy", true);
app.use(cookieSession({
    //not encrypted
    signed: false,
    //will run on https only
    secure: true
}))
app.use(currentUserRouter);
app.use(signinRouter);
app.use(signoutRouter);
app.use(signupRouter);

// app.all("*splat", async (req, res, next) => {
//     next(new NotFoundError());
// });


// Express 4 (Instructor's Version):

// Does not natively handle rejected Promises from async route handlers.
// Thrown async errors become unhandled, causing the request to hang indefinitely in Postman unless next(err) or express-async-errors is used.
// Express 5 (Your Version):

// Comes with built-in native support for async/await and Promises.
// Automatically intercepts any thrown async errors and forwards them straight to your error handler without hanging.

app.all("*splat", async () => {
    throw new NotFoundError()
})

app.use(errorHandler);

const start = async () => {
    if (!process.env.JWT_KEY) {
        throw new Error("JWT_KEY not defined");
    }
    try {
        await mongoose.connect("mongodb://auth-mongo-srv:27017/auth");
        console.log("Connected to Mongo!!!")
    } catch (e) {
        console.error(e);
    }
    app.listen(3000, () => {
        console.log("Server is running at port 3000!!!!");
    });
}
start();

