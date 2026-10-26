import { OrderDoc } from "../../models/order";
import { OrderCreatedEvent, OrderCancelledEvent, RefundRequestedEvent } from "@mehul-mrtickets/common";

export const toOrderCreatedEvent = (order: OrderDoc): OrderCreatedEvent["data"] => {
    const ticketId = typeof order.ticket === "object" && order.ticket !== null
        ? order.ticket.id
        : String(order.ticket);
    const ticketPrice = typeof order.ticket === "object" && order.ticket !== null
        ? (order.ticket as any).price
        : 0;

    return {
        id: order._id ? order._id.toHexString() : order.id,
        version: order.version,
        status: order.status,
        userId: order.userId,
        expiresAt: order.expiresAt instanceof Date ? order.expiresAt.toISOString() : String(order.expiresAt),
        ticket: {
            id: ticketId,
            price: ticketPrice,
        },
    };
};

export const toOrderCancelledEvent = (order: OrderDoc, ticketIdOverride?: string): OrderCancelledEvent["data"] => {
    const ticketId = ticketIdOverride || (
        typeof order.ticket === "object" && order.ticket !== null
            ? order.ticket.id
            : String(order.ticket)
    );

    return {
        id: order._id ? order._id.toHexString() : order.id,
        version: order.version,
        ticket: {
            id: ticketId,
        },
    };
};

export const toRefundRequestedEvent = (
    orderId: string,
    paymentId: string,
    reason?: string
): RefundRequestedEvent["data"] => ({
    orderId,
    paymentId,
    reason: reason || "Order expired or cancelled",
});
