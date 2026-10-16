import express, { Request, Response } from "express";
import { body } from "express-validator";
import {
    requireAuth,
    validateRequest,
    BadRequestError,
    NotFoundError,
    NotAuthorizedError,
    OrderStatus,
} from "@mehul-mrtickets/common";
import mongoose from "mongoose";
import { Order } from "../models/order";
import { Payment } from "../models/payment";
import { PaymentCreatedPublisher } from "../events/publishers/payment-created-publisher";
import { chargeCard } from "../services/stripe-client";

const router = express.Router();

router.post(
    "/api/payments",
    requireAuth,
    [
        body("token").notEmpty().withMessage("Token is required"),
        body("orderId")
            .notEmpty()
            .isMongoId()
            .withMessage("orderId must be a valid Mongo ID"),
    ],
    validateRequest,
    async (req: Request, res: Response) => {
        const { token, orderId } = req.body;

        const order = await Order.findById(orderId);

        if (!order) {
            throw new NotFoundError();
        }

        if (order.userId !== req.currentUser!.id) {
            throw new NotAuthorizedError();
        }

        if (order.status === OrderStatus.Cancelled) {
            throw new BadRequestError("Cannot pay for a cancelled order");
        }

        // 5-second pre-expiry guard: reject if expired or expiring within 5000ms
        if (order.expiresAt && order.expiresAt.getTime() - Date.now() < 5000) {
            throw new BadRequestError("Order has expired or is about to expire, please re-order");
        }

        // Layer 1: Application-level check
        const existingPayment = await Payment.findOne({ orderId });
        if (existingPayment) {
            throw new BadRequestError("Order is already paid");
        }

        // Layer 2: Payment Provider Idempotency Key wrapped in Circuit Breaker
        const charge = await chargeCard(
            {
                currency: "usd",
                amount: Math.round(order.price * 100),
                source: token,
            },
            `charge-${orderId}`
        );

        // Layer 3: Database Unique Constraint on orderId + Transactional Outbox
        let paymentDoc: any;
        try {
            await mongoose.connection.transaction(async (session) => {
                const payment = Payment.build({
                    orderId: orderId,
                    stripeId: charge.id,
                });

                await payment.save({ session });

                await new PaymentCreatedPublisher().publish(
                    {
                        id: payment.id,
                        orderId: payment.orderId,
                        stripeId: payment.stripeId,
                    },
                    session
                );

                paymentDoc = payment;
            });
        } catch (err: any) {
            if (err?.code === 11000) {
                throw new BadRequestError("Order is already paid");
            }
            throw err;
        }

        res.status(201).send({ id: paymentDoc.id });
    }
);

export { router as createPaymentRouter };