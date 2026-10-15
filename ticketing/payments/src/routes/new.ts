import express, { Request, Response } from "express";
import { body } from "express-validator";
import { requireAuth, validateRequest, BadRequestError, NotFoundError, NotAuthorizedError, OrderStatus } from "@mehul-mrtickets/common";
import { Order } from "../models/order";
import { stripe } from "../stripe";
import { Payment } from "../models/payment";
import { PaymentCreatedPublisher } from "../events/publishers/payment-created-publisher";
import { kafkaWrapper } from "../kafka-wrapper";

const router = express.Router();

router.post(
    "/api/payments",
    requireAuth,
    [
        body("token").notEmpty().withMessage("Token is required"),
        body("orderId")
            .notEmpty()
            .isMongoId()
            .withMessage("orderId must be a valid Mongo ID")
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

        // Layer 1: Application-level check
        const existingPayment = await Payment.findOne({ orderId });
        if (existingPayment) {
            throw new BadRequestError("Order is already paid");
        }

        // Layer 2: Payment Provider Idempotency Key
        const charge = await stripe.charges.create(
            {
                currency: "usd",
                amount: Math.round(order.price * 100),
                source: token,
            },
            {
                idempotencyKey: `charge-${orderId}`
            }
        );

        // Layer 3: Database Unique Constraint on orderId
        const payment = Payment.build({
            orderId: orderId,
            stripeId: charge.id,
        });

        try {
            await payment.save();
        } catch (err: any) {
            if (err?.code === 11000) {
                throw new BadRequestError("Order is already paid");
            }
            throw err;
        }

        await new PaymentCreatedPublisher(kafkaWrapper.producer).publish({
            id: payment.id,
            orderId: payment.orderId,
            stripeId: payment.stripeId,
        });

        res.status(201).send({ id: payment.id });
    }
);

export { router as createPaymentRouter };