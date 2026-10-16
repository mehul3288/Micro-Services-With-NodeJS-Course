import mongoose from "mongoose";
import { acquireLease, OrderStatus, createLogger, ordersSweptCounter } from "@mehul-mrtickets/common";
import { Order } from "../models/order";
import { cancelOrder } from "../services/cancel-order";

const logger = createLogger("orders");

export class ExpireOrdersSweeper {
    private timer?: NodeJS.Timeout;
    private running = false;
    private readonly instanceId = `${process.pid}-${Math.random().toString(36).substring(2, 9)}`;

    constructor(
        private pollIntervalMs = 60000,
        private gracePeriodMs = 30000
    ) {}

    start(): void {
        this.running = true;
        this.scheduleNext();
    }

    stop(): void {
        this.running = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }

    private scheduleNext(): void {
        if (!this.running) {
            return;
        }
        this.timer = setTimeout(async () => {
            try {
                await this.sweep();
            } catch (err) {
                logger.error({ err }, "[ExpireOrdersSweeper] Error during sweep");
            } finally {
                this.scheduleNext();
            }
        }, this.pollIntervalMs);
    }

    async sweep(): Promise<number> {
        // Attempt to acquire distributed lease for 30 seconds
        const hasLease = await acquireLease("expire-orders-sweeper", this.instanceId, 30000);
        if (!hasLease) {
            return 0;
        }

        const cutoff = new Date(Date.now() - this.gracePeriodMs);
        const expiredOrders = await Order.find({
            status: OrderStatus.Created,
            expiresAt: { $lt: cutoff },
        }).populate("ticket").limit(100);

        let sweptCount = 0;
        for (const order of expiredOrders) {
            try {
                await mongoose.connection.transaction(async (session) => {
                    const cancelled = await cancelOrder(order, session);
                    if (cancelled) {
                        sweptCount++;
                    }
                });
            } catch (err) {
                logger.error({ err, orderId: order.id }, "[ExpireOrdersSweeper] Failed to sweep order");
            }
        }

        if (sweptCount > 0) {
            ordersSweptCounter.inc({ service: "orders" }, sweptCount);
            logger.info({ sweptCount }, "[ExpireOrdersSweeper] Swept and cancelled expired orders");
        }

        return sweptCount;
    }
}
