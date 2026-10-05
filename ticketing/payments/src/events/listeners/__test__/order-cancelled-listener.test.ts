import { OrderCancelledEvent, OrderStatus } from "@mehul-mrtickets/common";
import { Message } from "node-nats-streaming";

import { Order } from "../../../models/order";
import { OrderCancelledListener } from "../order-cancelled-listener";
import { natsWrapper } from "../../../nats-wrapper";
import mongoose from "mongoose";

const setup = async () => {
    const listener = new OrderCancelledListener(natsWrapper.client);

    const order = Order.build({
        id: new mongoose.Types.ObjectId().toHexString(),
        version: 0,
        userId: new mongoose.Types.ObjectId().toHexString(),
        price: 20,
        status: OrderStatus.Created
    })

    await order.save();

    const data: OrderCancelledEvent["data"] = {
        id: order._id.toHexString(),
        version: 1,
        ticket: {
            id: new mongoose.Types.ObjectId().toHexString()
        }
    };

    // @ts-ignore
    const msg: Message = {
        ack: jest.fn()
    };

    return { listener, data, msg, order };
};

it("marks the order as cancelled", async () => {
    const { listener, data, order, msg } = await setup();

    await listener.onMessage(data, msg);

    const updatedOrder = await Order.findById(order._id.toHexString());

    expect(updatedOrder).toBeDefined();
    expect(updatedOrder!.status).toEqual(OrderStatus.Cancelled);
});

it("acks the message", async () => {
    const { listener, data, msg } = await setup();

    await listener.onMessage(data, msg);

    expect(msg.ack).toHaveBeenCalled();
});