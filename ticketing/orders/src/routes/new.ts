import express, { Request, Response } from "express";
import { BadRequestError, NotFoundError, OrderStatus, requireAuth, validateRequest } from "@mehul-mrtickets/common";
import { body } from "express-validator";
import mongoose from "mongoose";
import { Ticket } from "../models/ticket";
import { Order } from "../models/order";
import { OrderCreatedPublisher } from "../events/publishers/order-created-publisher";
import { natsWrapper } from "../nats-wrapper";
const router = express.Router();
const EXPIRATION_WINDOW_SECONDS = 1 * 60;


//Here we are assuming that the ticketId will always be a type of mongodb id but in future we can change the db to any other type and there we can have another type of id so we are coupling this logic over here and we should put this to a common area like a common library from where we can access this. for e.g, we can have another ticket service which uses different db and we can use that particular library method  to validate the id
router.post("/api/orders", requireAuth, body("ticketId").notEmpty().custom((input: string) => mongoose.Types.ObjectId.isValid(input)).withMessage("TicketId must be provided"), validateRequest, async (req: Request, res: Response) => {
    const { ticketId } = req.body;
    // Find the ticket the user id trying to order in the database
    const ticket = await Ticket.findById(ticketId)
    if (!ticket) {
        throw new NotFoundError();
    }
    // Make sure that this ticket is not already reserved

    const isReserved = await ticket.isReserved();

    if (isReserved) {
        throw new BadRequestError("Ticket is already reserved");
    }


    //Calulate an expiration date for order
    const expiration = new Date();
    expiration.setSeconds(expiration.getSeconds() + EXPIRATION_WINDOW_SECONDS);

    //Build the order and save it to db
    const order = Order.build({
        userId: req.currentUser!.id,
        status: OrderStatus.Created,
        expiresAt: expiration,
        ticket: ticket
    })

    await order.save();

    //Publish an event saying that an order was created
    await new OrderCreatedPublisher(natsWrapper.client).publish({
        id: order._id.toHexString(),
        status: order.status,
        userId: order.userId,
        expiresAt: order.expiresAt.toISOString(),
        version: order.version,
        ticket: {
            id: ticket.id,
            price: ticket.price,
        }

    })

    res.status(201).send(order);
})

export { router as newOrderRouter };