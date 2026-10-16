import express, { Request, Response } from "express";
import { BadRequestError, NotAuthorizedError, NotFoundError, OrderStatus, requireAuth } from "@mehul-mrtickets/common";
import mongoose from "mongoose";
import { Order } from "../models/order";
import { canTransition } from "../models/order-transitions";
import { cancelOrder } from "../services/cancel-order";

const router = express.Router();

router.delete("/api/orders/:orderId", requireAuth, async (req: Request, res: Response) => {
    const order = await Order.findById(req.params.orderId).populate("ticket");

    if (!order) {
        throw new NotFoundError();
    }
    if (order.userId !== req.currentUser!.id) {
        throw new NotAuthorizedError();
    }

    if (!canTransition(order.status, OrderStatus.Cancelled)) {
        if (order.status === OrderStatus.Cancelled) {
            return res.status(204).send(order);
        }
        throw new BadRequestError("Cannot cancel an order in this status");
    }

    await mongoose.connection.transaction(async (session) => {
        await cancelOrder(order, session);
    });

    res.status(204).send(order);
});

export { router as deleteOrderRouter };