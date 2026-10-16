import { OrderStatus } from "@mehul-mrtickets/common";

const allowedTransitions: Record<OrderStatus, OrderStatus[]> = {
    [OrderStatus.Created]: [
        OrderStatus.AwaitingPayment,
        OrderStatus.Complete,
        OrderStatus.Cancelled,
    ],
    [OrderStatus.AwaitingPayment]: [
        OrderStatus.Complete,
        OrderStatus.Cancelled,
    ],
    [OrderStatus.Complete]: [],
    [OrderStatus.Cancelled]: [],
};

export const canTransition = (from: OrderStatus, to: OrderStatus): boolean => {
    return allowedTransitions[from]?.includes(to) ?? false;
};
