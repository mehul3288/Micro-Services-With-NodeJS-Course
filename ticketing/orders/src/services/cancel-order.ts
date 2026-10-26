import { ClientSession } from "mongoose";
import { OrderStatus } from "@mehul-mrtickets/common";
import { OrderDoc } from "../models/order";
import { Ticket } from "../models/ticket";
import { OrderCancelledPublisher } from "../events/publishers/order-cancelled-publisher";
import { canTransition } from "../models/order-transitions";
import { toOrderCancelledEvent } from "../events/builders/order-event-builders";

export const cancelOrder = async (order: OrderDoc, session?: ClientSession): Promise<boolean> => {
    if (!canTransition(order.status, OrderStatus.Cancelled)) {
        return false;
    }

    const ticketId = typeof order.ticket === "object" && order.ticket !== null
        ? order.ticket.id
        : String(order.ticket);

    // Release the atomic ticket reservation
    if (ticketId) {
        await Ticket.release(ticketId, order.id, session);
    }

    order.set({ status: OrderStatus.Cancelled });
    await order.save({ session });

    await new OrderCancelledPublisher().publish(
        toOrderCancelledEvent(order, ticketId),
        session
    );

    return true;
};
