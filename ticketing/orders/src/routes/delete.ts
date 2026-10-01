import express, { Request, Response } from "express";
import { NotAuthorizedError, NotFoundError, OrderStatus, requireAuth } from "@mehul-mrtickets/common";
import { Order } from "../models/order";
import { OrderCancelledPublisher } from "../events/publishers/order-cancelled-publisher";
import { natsWrapper } from "../nats-wrapper";

const router = express.Router();

router.delete("/api/orders/:orderId", requireAuth, async (req: Request, res: Response) => {
    const order = await Order.findById(req.params.orderId);
    // const order = await Order.findById(req.params.orderId).populate("ticket");

    if (!order) {
        throw new NotFoundError();
    }
    if (order.userId !== req.currentUser!.id) {
        throw new NotAuthorizedError();
    }

    order.status = OrderStatus.Cancelled;
    await order.save();

    //publishing an event that order is cancelled
    await new OrderCancelledPublisher(natsWrapper.client).publish({
        id: order.id,
        version: order.version,
        ticket: {
            id: order.ticket.toString()
            // id:order.ticket._id.toString()
        }
    })

    res.status(204).send(order);
})

export { router as deleteOrderRouter };