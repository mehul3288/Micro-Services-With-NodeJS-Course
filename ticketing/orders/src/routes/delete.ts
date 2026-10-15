import express, { Request, Response } from "express";
import { BadRequestError, NotAuthorizedError, NotFoundError, OrderStatus, requireAuth } from "@mehul-mrtickets/common";
import { Order } from "../models/order";
import { Ticket } from "../models/ticket";
import { OrderCancelledPublisher } from "../events/publishers/order-cancelled-publisher";
import { kafkaWrapper } from "../kafka-wrapper";

const router = express.Router();

router.delete("/api/orders/:orderId", requireAuth, async (req: Request, res: Response) => {
    const order = await Order.findById(req.params.orderId).populate("ticket");

    if (!order) {
        throw new NotFoundError();
    }
    if (order.userId !== req.currentUser!.id) {
        throw new NotAuthorizedError();
    }

    if (order.status === OrderStatus.Complete) {
        throw new BadRequestError("Cannot cancel a paid order");
    }

    // Idempotent: if already cancelled, return immediately without re-publishing
    if (order.status === OrderStatus.Cancelled) {
        return res.status(204).send(order);
    }

    // Release the atomic ticket reservation
    await Ticket.release(order.ticket.id, order.id);

    order.status = OrderStatus.Cancelled;
    await order.save();

    await new OrderCancelledPublisher(kafkaWrapper.producer).publish({
        id: order.id,
        version: order.version,
        ticket: {
            id: order.ticket.id
        }
    });

    res.status(204).send(order);
});

export { router as deleteOrderRouter };