import express, { Request, Response } from "express";
import mongoose from "mongoose";
import { Ticket } from "../models/ticket";
import { body } from "express-validator";
import {
    BadRequestError,
    NotAuthorizedError,
    NotFoundError,
    requireAuth,
    validateRequest,
} from "@mehul-mrtickets/common";
import { TicketUpdatedPublisher } from "../events/publishers/ticket-updated-publisher";
import { ticketCache } from "../services/ticket-cache";
import { toTicketUpdatedEvent } from "../events/builders/ticket-event-builders";

const router = express.Router();

router.put(
    "/api/tickets/:id",
    requireAuth,
    [
        body("title").notEmpty().withMessage("Title is required"),
        body("price").notEmpty().isFloat({ gt: 0 }).withMessage("Price is required"),
    ],
    validateRequest,
    async (req: Request, res: Response) => {
        let updatedTicket: any;

        await mongoose.connection.transaction(async (session) => {
            const ticket = await Ticket.findById(req.params.id).session(session);
            if (!ticket) {
                throw new NotFoundError();
            }
            if (ticket.userId !== req.currentUser?.id) {
                throw new NotAuthorizedError();
            }

            if (ticket.orderId) {
                throw new BadRequestError("Cannot edit a reserved ticket!");
            }

            ticket.set({
                title: req.body.title,
                price: req.body.price,
            });
            await ticket.save({ session });

            await new TicketUpdatedPublisher().publish(
                toTicketUpdatedEvent(ticket),
                session
            );

            updatedTicket = ticket;
        });

        // Invalidate individual ticket cache and list cache post-commit
        if (updatedTicket) {
            await ticketCache.invalidate(updatedTicket.id);
        }

        res.send(updatedTicket);
    }
);

export { router as updateTicketRouter };