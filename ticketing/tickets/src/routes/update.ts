import express, { Request, Response } from "express";
import { Ticket } from "../models/ticket";
import { body } from "express-validator";
import { BadRequestError, NotAuthorizedError, NotFoundError, requireAuth, validateRequest } from "@mehul-mrtickets/common";
import { TicketUpdatedPublisher } from "../events/publishers/ticket-updated-publisher";
import { natsWrapper } from "../nats-wrapper";

const router = express.Router();

router.put("/api/tickets/:id", requireAuth, [body("title").notEmpty().withMessage("Title is required"), body("price").notEmpty().isFloat({ gt: 0 }).withMessage("Price is required")], validateRequest, async (req: Request, res: Response) => {

    const ticket = await Ticket.findById(req.params.id);
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
        price: req.body.price
    })
    await ticket.save();
    await new TicketUpdatedPublisher(natsWrapper.client).publish({
        id: ticket.id,
        title: ticket.title,
        price: ticket.price,
        userId: ticket.userId,
        version: ticket.version
    })
    res.send(ticket)



})

export { router as updateTicketRouter };