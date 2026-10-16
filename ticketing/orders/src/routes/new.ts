import express, { Request, Response } from "express";
import { BadRequestError, NotFoundError, OrderStatus, requireAuth, validateRequest } from "@mehul-mrtickets/common";
import { body } from "express-validator";
import mongoose from "mongoose";
import { Ticket } from "../models/ticket";
import { Order } from "../models/order";
import { OrderCreatedPublisher } from "../events/publishers/order-created-publisher";

const router = express.Router();
const EXPIRATION_WINDOW_SECONDS = 1 * 60;

router.post(
    "/api/orders",
    requireAuth,
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
        expiration.setSeconds(expiration.getSeconds() + EXPIRATION_WINDOW_SECONDS);

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

            await new OrderCreatedPublisher().publish({
                id: order._id.toHexString(),
                status: order.status,
                userId: order.userId,
                expiresAt: order.expiresAt.toISOString(),
                version: order.version,
                ticket: {
                    id: ticket.id,
                    price: ticket.price,
                },
            }, session);

            orderDoc = order;
        });

        res.status(201).send(orderDoc);
    }
);

export { router as newOrderRouter };