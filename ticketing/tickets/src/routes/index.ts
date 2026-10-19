import express, { Request, Response } from "express";
import { Ticket } from "../models/ticket";
import { ticketCache } from "../services/ticket-cache";

const router = express.Router();

router.get("/api/tickets", async (req: Request, res: Response) => {
    const isFirstPage = !req.query.after && (!req.query.limit || Number(req.query.limit) === 20);

    // 1. If requesting default first page catalog, check cache first
    if (isFirstPage) {
        const cachedList = await ticketCache.getList();
        if (cachedList) {
            return res.send(cachedList);
        }
    }

    // 2. Cache miss or deep pagination: Query MongoDB
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const filter: any = { orderId: undefined };

    if (req.query.after && typeof req.query.after === "string") {
        filter._id = { $gt: req.query.after };
    }

    const tickets = await Ticket.find(filter).sort({ _id: 1 }).limit(limit);
    const nextCursor = tickets.length === limit ? tickets[tickets.length - 1].id : null;
    const responsePayload = { tickets, nextCursor };

    // 3. Cache the first page catalog (non-blocking)
    if (isFirstPage) {
        ticketCache.setList(responsePayload);
    }

    res.send(responsePayload);
});

export { router as indexTicketRouter };