import { Subjects } from "./subjects";

export enum Topics {
    TicketEvents = "ticket-events",
    OrderEvents = "order-events",
    PaymentEvents = "payment-events",
    ExpirationEvents = "expiration-events",
}

export const topicFor: Record<Subjects, Topics> = {
    [Subjects.TicketCreated]: Topics.TicketEvents,
    [Subjects.TicketUpdated]: Topics.TicketEvents,
    [Subjects.OrderCreated]: Topics.OrderEvents,
    [Subjects.OrderCancelled]: Topics.OrderEvents,
    [Subjects.PaymentCreated]: Topics.PaymentEvents,
    [Subjects.ExpirationComplete]: Topics.ExpirationEvents,
};
