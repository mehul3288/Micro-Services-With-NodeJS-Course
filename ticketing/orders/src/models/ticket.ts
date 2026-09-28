import mongoose, { Schema } from "mongoose";
import { Order, OrderStatus } from "./order";

interface TicketAttrs {
    title: string,
    price: number
}

export interface TicketDoc extends mongoose.Document {
    title: string,
    price: number,
    isReserved(): Promise<boolean>;
}

interface TicketModel extends mongoose.Model<TicketDoc> {
    build(attrs: TicketAttrs): TicketDoc
}

const ticketSchema = new Schema<TicketDoc, TicketModel>({
    title: {
        type: String,
        required: true
    },
    price: {
        type: Number,
        required: true,
        min: 0
    }
}, {
    toJSON: {
        transform(doc, ret: any) {
            ret.id = ret._id;
            delete ret._id;
            delete ret.__v;
        }
    }
})

//Ye ticket ke individual document ke upr method add krega not on the model
ticketSchema.methods.isReserved = async function () {
    // this === full document that we called 
    // Run query to look at all orders. Find an order where the ticket is the ticket we just found
    // and that order is not cancelled. If found throw error
    const existingOrder = await Order.findOne({
        ticket: this,
        status: {
            $in: [
                OrderStatus.Created,
                OrderStatus.AwaitingPayment,
                OrderStatus.Complete
            ]
        }
    })

    return !!existingOrder;
};

// ticketSchema.statics.isReserved = async (ticket: TicketDoc) => {
//     const existingOrder = await Order.findOne({
//         ticket: ticket,
//         status: {
//             $in: [
//                 OrderStatus.Created,
//                 OrderStatus.AwaitingPayment,
//                 OrderStatus.Complete
//             ]
//         }
//     })

//     return !!existingOrder;
// }

ticketSchema.statics.build = (attrs: TicketAttrs) => {
    return new Ticket(attrs);
}

const Ticket = mongoose.model<TicketDoc, TicketModel>("Ticket", ticketSchema);

export { Ticket };