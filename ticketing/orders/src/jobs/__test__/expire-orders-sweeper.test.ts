import mongoose from "mongoose";
import { OrderStatus, OutboxEvent, Subjects } from "@mehul-mrtickets/common";
import { Ticket } from "../../models/ticket";
import { Order } from "../../models/order";
import { ExpireOrdersSweeper } from "../expire-orders-sweeper";

describe("ExpireOrdersSweeper", () => {
    it("sweeps expired orders, updates status to Cancelled, releases ticket, and creates outbox event", async () => {
        const ticket = Ticket.build({
            id: new mongoose.Types.ObjectId().toHexString(),
            title: "Rock Concert",
            price: 50,
        });
        await ticket.save();

        // Expired 60s ago
        const expiredAt = new Date(Date.now() - 60000);
        const order = Order.build({
            userId: "user-123",
            status: OrderStatus.Created,
            expiresAt: expiredAt,
            ticket,
        });
        await order.save();
        await Ticket.reserve(ticket.id, order.id);

        // Sweeper with 10s grace period (so 60s ago is definitely beyond cutoff)
        const sweeper = new ExpireOrdersSweeper(60000, 10000);
        const count = await sweeper.sweep();

        expect(count).toEqual(1);

        const updatedOrder = await Order.findById(order.id);
        expect(updatedOrder!.status).toEqual(OrderStatus.Cancelled);

        const updatedTicket = await Ticket.findById(ticket.id);
        expect(updatedTicket!.reservedBy).toBeNull();

        const outboxEvents = await OutboxEvent.find({ eventType: Subjects.OrderCancelled });
        expect(outboxEvents.length).toEqual(1);
    });

    it("ignores unexpired orders and completed orders", async () => {
        const ticket1 = Ticket.build({
            id: new mongoose.Types.ObjectId().toHexString(),
            title: "Show 1",
            price: 30,
        });
        await ticket1.save();

        // Still has 60 seconds left
        const futureExpiry = new Date(Date.now() + 60000);
        const unexpiredOrder = Order.build({
            userId: "user-1",
            status: OrderStatus.Created,
            expiresAt: futureExpiry,
            ticket: ticket1,
        });
        await unexpiredOrder.save();

        const ticket2 = Ticket.build({
            id: new mongoose.Types.ObjectId().toHexString(),
            title: "Show 2",
            price: 40,
        });
        await ticket2.save();

        // Already complete
        const completedOrder = Order.build({
            userId: "user-2",
            status: OrderStatus.Complete,
            expiresAt: new Date(Date.now() - 60000),
            ticket: ticket2,
        });
        await completedOrder.save();

        const sweeper = new ExpireOrdersSweeper(60000, 10000);
        const count = await sweeper.sweep();

        expect(count).toEqual(0);

        const checkedOrder1 = await Order.findById(unexpiredOrder.id);
        expect(checkedOrder1!.status).toEqual(OrderStatus.Created);

        const checkedOrder2 = await Order.findById(completedOrder.id);
        expect(checkedOrder2!.status).toEqual(OrderStatus.Complete);
    });
});
