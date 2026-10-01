import { Message } from "node-nats-streaming"
import { Listener, Subjects, TicketCreatedEvent } from "@mehul-mrtickets/common";
import { Ticket } from "../../models/ticket";
import { queueGroupName } from "./queue-group-name";

export class TicketCreatedListener extends Listener<TicketCreatedEvent> {
    subject: Subjects.TicketCreated = Subjects.TicketCreated;
    queueGroupName: string = queueGroupName;
    async onMessage(data: TicketCreatedEvent['data'], msg: Message) {
        const ticket = Ticket.build({
            id: data.id,
            title: data.title,
            price: data.price
        })

        await ticket.save();
        msg.ack();
    }
}