import express, { Request, Response } from "express";
import { NotFoundError, requireAuth } from "@mehul-mrtickets/common";
import { Order } from "../models/order";

const router = express.Router();

router.get("/api/orders", requireAuth, async (req: Request, res: Response) => {
    const orders = await Order.find({
        userId: req.currentUser!.id
    }).populate('ticket');
    console.log(orders);
    if (!orders) {
        throw new NotFoundError();
    }
    res.status(200).send(orders);
})

export { router as indexOrderRouter };