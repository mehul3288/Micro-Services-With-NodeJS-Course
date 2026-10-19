import express, { Request, Response } from "express";
import { Ticket } from "../models/ticket";
import { NotFoundError } from "@mehul-mrtickets/common";
import { ticketCache } from "../services/ticket-cache";

const router = express.Router();

router.get("/api/tickets/:id", async (req: Request, res: Response) => {
    const ticketId = req.params.id as string;

    // 1. Check cache first
    const cachedTicket = await ticketCache.get(ticketId);
    if (cachedTicket) {
        return res.send(cachedTicket);
    }

    // 2. Cache miss: Query MongoDB
    const ticket = await Ticket.findById(req.params.id);
    if (!ticket) {
        throw new NotFoundError();
    }

    // 3. Populate cache (non-blocking)
    ticketCache.set(ticket);

    res.send(ticket);
});

export { router as showTicketRouter };