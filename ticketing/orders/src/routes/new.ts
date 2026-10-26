import express, { Request, Response } from "express";
import { BadRequestError, NotFoundError, OrderStatus, requireAuth, validateRequest } from "@mehul-mrtickets/common";
import { body } from "express-validator";
import mongoose from "mongoose";
import { Ticket } from "../models/ticket";
import { Order } from "../models/order";
import { OrderCreatedPublisher } from "../events/publishers/order-created-publisher";
import { orderRateLimiter } from "../middlewares/order-rate-limiter";
import { toOrderCreatedEvent } from "../events/builders/order-event-builders";

const router = express.Router();
const getExpirationWindowSeconds = (): number => {
    const envVal = process.env.ORDER_EXPIRATION_SECONDS;
    if (envVal && !isNaN(parseInt(envVal, 10))) {
        return parseInt(envVal, 10);
    }
    return 60;
};

router.post(
    "/api/orders",
    requireAuth,
    orderRateLimiter,
    body("ticketId")
        .notEmpty()
        .custom((input: string) => mongoose.Types.ObjectId.isValid(input))
        .withMessage("TicketId must be provided"),
    validateRequest,
    async (req: Request, res: Response) => {
        const { ticketId } = req.body;

        const ticket = await Ticket.findById(ticketId);
        if (!ticket) {
            throw new NotFoundError();
        }

        const expiration = new Date();
        expiration.setSeconds(expiration.getSeconds() + getExpirationWindowSeconds());

        let orderDoc: any;

        await mongoose.connection.transaction(async (session) => {
            const order = Order.build({
                userId: req.currentUser!.id,
                status: OrderStatus.Created,
                expiresAt: expiration,
                ticket: ticket,
            });

            // Atomic check-and-reserve: only one concurrent request can transition reservedBy from null to order.id
            const reservedTicket = await Ticket.reserve(ticket.id, order.id, session);
            if (!reservedTicket) {
                throw new BadRequestError("Ticket is already reserved");
            }

            await order.save({ session });

            await new OrderCreatedPublisher().publish(toOrderCreatedEvent(order), session);

            orderDoc = order;
        });

        res.status(201).send(orderDoc);
    }
);

export { router as newOrderRouter };