import mongoose from "mongoose";
import { Ticket } from "../../../models/ticket";
import { natsWrapper } from "../../../nats-wrapper";
import { ExpirationCompleteListener } from "../expiration-complete-listener";
import { ExpirationCompleteEvent, OrderStatus } from "@mehul-mrtickets/common";
import { Order } from "../../../models/order";

const setup = async () => {
    const listener = new ExpirationCompleteListener(natsWrapper.client)

    const ticket = Ticket.build({
        id: new mongoose.Types.ObjectId().toHexString(),
        title: " Concert",
        price: 20,
    })

    await ticket.save();
    const order = Order.build({
        userId: new mongoose.Types.ObjectId().toHexString(),
        status: OrderStatus.Created,
        ticket,
        expiresAt: new Date()
    })

    await order.save();


    const data: ExpirationCompleteEvent["data"] = {
        orderId: order._id.toHexString(),
    };

    //@ts-ignore
    const msg: Message = {
        ack: jest.fn(),
    };

    return {
        listener,
        data,
        order,
        msg
    }

}

it("Update the status to cancelled", async () => {
    const { listener, data, order, msg } = await setup();
    await listener.onMessage(data, msg);
    const updatedOrder = await Order.findById(data.orderId);
    expect(updatedOrder!.status).toEqual(OrderStatus.Cancelled)
})

it("emits an orderCancelled event", async () => {
    const { listener, data, order, msg } = await setup();
    await listener.onMessage(data, msg);
    expect(natsWrapper.client.publish).toHaveBeenCalled();
    const eventData = JSON.parse((natsWrapper.client.publish as jest.Mock).mock.calls[0][1]);
    expect(eventData.id).toEqual(order._id.toString());

})

it("acks the message", async () => {
    const { listener, data, order, msg } = await setup();
    await listener.onMessage(data, msg);
    expect(msg.ack).toHaveBeenCalled();
})