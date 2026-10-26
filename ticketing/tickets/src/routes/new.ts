import { requireAuth, validateRequest } from "@mehul-mrtickets/common";
import { body } from "express-validator";
import express, { Request, Response } from "express";
import mongoose from "mongoose";
import { Ticket } from "../models/ticket";
import { TicketCreatedPublisher } from "../events/publishers/ticket-created-publisher";
import { ticketCache } from "../services/ticket-cache";
import { toTicketCreatedEvent } from "../events/builders/ticket-event-builders";

const router = express.Router();

router.post(
    "/api/tickets",
    requireAuth,
    [body("title").not().isEmpty().withMessage("Title is required")],
    [body("price").isFloat({ gt: 0 }).withMessage("Price must be greater than 0")],
    validateRequest,
    async (req: Request, res: Response) => {
        const { title, price } = req.body;

        let createdTicket: any;

        await mongoose.connection.transaction(async (session) => {
            const ticket = Ticket.build({ title, price, userId: req.currentUser!.id });
            await ticket.save({ session });

            await new TicketCreatedPublisher().publish(
                toTicketCreatedEvent(ticket),
                session
            );

            createdTicket = ticket;
        });

        // Invalidate catalog cache post-commit
        await ticketCache.invalidate();

        res.status(201).send(createdTicket);
    }
);

export { router as createTicketRouter };