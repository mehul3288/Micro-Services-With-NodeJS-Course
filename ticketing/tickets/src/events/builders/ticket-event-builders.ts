import { TicketDoc } from "../../models/ticket";
import { TicketCreatedEvent, TicketUpdateEvent } from "@mehul-mrtickets/common";

export const toTicketCreatedEvent = (ticket: TicketDoc): TicketCreatedEvent["data"] => ({
    id: ticket.id,
    title: ticket.title,
    price: ticket.price,
    userId: ticket.userId,
    version: ticket.version,
});

export const toTicketUpdatedEvent = (ticket: TicketDoc): TicketUpdateEvent["data"] => ({
    id: ticket.id,
    title: ticket.title,
    price: ticket.price,
    userId: ticket.userId,
    version: ticket.version,
    orderId: ticket.orderId,
});
