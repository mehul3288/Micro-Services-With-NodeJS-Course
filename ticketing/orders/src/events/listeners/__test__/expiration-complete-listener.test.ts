import mongoose from "mongoose";
import { Ticket } from "../../../models/ticket";
import { natsWrapper } from "../../../nats-wrapper";
import { ExpirationCompleteListener } from "../expiration-complete-listener";
import { ExpirationCompleteEvent, OrderStatus } from "@mehul-mrtickets/common";
import { Order } from "../../../models/order";

const setup = async () => {
    const listener = new ExpirationCompleteListener(natsWrapper.client);

    const ticket = Ticket.build({
        id: new mongoose.Types.ObjectId().toHexString(),
        title: "Concert",
        price: 20,
    });
    await ticket.save();

    const order = Order.build({
        userId: new mongoose.Types.ObjectId().toHexString(),
        status: OrderStatus.Created,
        ticket,
        expiresAt: new Date()
    });
    await order.save();

    // Reserve ticket
    await Ticket.reserve(ticket.id, order.id);

    const data: ExpirationCompleteEvent["data"] = {
        orderId: order.id,
    };

    //@ts-ignore
    const msg: Message = {
        ack: jest.fn(),
    };

    return {
        listener,
        ticket,
        data,
        order,
        msg
    };
};

it("updates the order status to cancelled and releases the ticket", async () => {
    const { listener, data, ticket, msg } = await setup();
    await listener.onMessage(data, msg);

    const updatedOrder = await Order.findById(data.orderId);
    expect(updatedOrder!.status).toEqual(OrderStatus.Cancelled);

    const updatedTicket = await Ticket.findById(ticket.id);
    expect(updatedTicket?.reservedBy).toBeNull();
});

it("emits an orderCancelled event", async () => {
    const { listener, data, order, msg } = await setup();
    await listener.onMessage(data, msg);
    expect(natsWrapper.client.publish).toHaveBeenCalled();
    const eventData = JSON.parse((natsWrapper.client.publish as jest.Mock).mock.calls[0][1]);
    expect(eventData.id).toEqual(order.id);
});

it("acks the message", async () => {
    const { listener, data, msg } = await setup();
    await listener.onMessage(data, msg);
    expect(msg.ack).toHaveBeenCalled();
});