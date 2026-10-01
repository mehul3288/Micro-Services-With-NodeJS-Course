import { Message } from "node-nats-streaming"
import { Listener, NotFoundError, Subjects, TicketUpdateEvent } from "@mehul-mrtickets/common";
import { Ticket } from "../../models/ticket";
import { queueGroupName } from "./queue-group-name";

export class TicketUpdatedListener extends Listener<TicketUpdateEvent> {
    subject: Subjects.TicketUpdated = Subjects.TicketUpdated;
    queueGroupName: string = queueGroupName;
    async onMessage(data: TicketUpdateEvent['data'], msg: Message) {
        const ticket = await Ticket.findByEvent(data)
        if (!ticket) {
            throw new Error("Ticket not found");
        }
        ticket.set({
            title: data.title,
            price: data.price
        })
        await ticket.save();
        msg.ack();
    }
}