import { OrderCreatedEvent, OrderStatus } from "@mehul-mrtickets/common"
import { Ticket } from "../../../models/ticket"
import { natsWrapper } from "../../../nats-wrapper"
import { OrderCreatedListener } from "../order-created-listener"
import mongoose from "mongoose"


const setup = async () => {
    // create an instance of the listener
    const listener = new OrderCreatedListener(natsWrapper.client)

    //create and save a ticket
    const ticket = Ticket.build({
        title: "concert",
        price: 99,
        userId: "wsd"
    })

    await ticket.save();

    //create the fake data event
    const data: OrderCreatedEvent["data"] = {
        id: new mongoose.Types.ObjectId().toHexString(),
        version: 0,
        status: OrderStatus.Created,
        userId: new mongoose.Types.ObjectId().toHexString(),
        expiresAt: "2025-10-01T12:00:00.000Z",
        ticket: {
            id: ticket.id,
            price: ticket.price
        }
    }


    // Create a fake message object
    //@ts-ignore
    const msg: Message = {
        ack: jest.fn()
    }

    return { listener, ticket, data, msg }
}

it("Ticket reserved", async () => {
    const { listener, ticket, data, msg } = await setup();

    //call the onMessage function with the fake data
    await listener.onMessage(data, msg);

    //write assertion to make sure the ticket is reserved
    const updatedTicket = await Ticket.findById(ticket.id);

    expect(updatedTicket).toBeDefined();
    expect(updatedTicket?.orderId).toEqual(data.id);

    //make sure that the nats wrapper was called
    expect(msg.ack).toHaveBeenCalled();
})

it("publishes a ticket updated event", async () => {
    const { listener, ticket, data, msg } = await setup();

    await listener.onMessage(data, msg);

    //@ts-ignore
    //Using this we can see whatever argumnets are passed to the publish function. [["ticket:updated", "..."]]
    // [
    //   [
    //     'ticket:updated',
    //     '{"id":"6abe0d16db52df2af71e0501","version":1,"title":"concert","price":99,"userId":"wsd","orderId":"6abe0d16db52df2af71e0502"}',
    //     [Function (anonymous)]
    //   ]
    // ]
    // console.log(natsWrapper.client.publish.mock.calls);

    //If you want to use the typed arguments of the publish function you can cast it to jest.Mock
    const ticketUpdated = JSON.parse((natsWrapper.client.publish as jest.Mock).mock.calls[0][1])
    expect(data.id).toEqual(ticketUpdated.orderId)

    expect(natsWrapper.client.publish).toHaveBeenCalled();

})
