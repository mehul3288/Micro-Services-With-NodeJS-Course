import { OrderStatus } from "@mehul-mrtickets/common";
import mongoose, { HydratedDocument, model, Model, Schema } from "mongoose";
import { TicketDoc } from "./ticket";

export { OrderStatus }

interface OrderAttrs {
    userId: string,
    status: OrderStatus,
    expiresAt: Date,
    ticket: TicketDoc
}

interface OrderModel extends Model<OrderAttrs> {
    build(attrs: OrderAttrs): HydratedDocument<OrderAttrs>;
}

// Doc Type-> TicketAttrs
// Ticketmodel inheriting all the model function along with build method we defined above
const ticketSchema = new Schema<OrderAttrs, OrderModel>({
    userId: {
        type: String,
        required: true
    },
    status: {
        type: String,
        required: true,
        enum: Object.values(OrderStatus),
        default: OrderStatus.Created
    },
    expiresAt: {
        type: Date
    },
    ticket: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Ticket"
    }
}, {
    toJSON: {
        transform(doc, ret: any) {
            ret.id = ret._id
            delete ret._id
        }
    }
})

ticketSchema.statics.build = (attrs: OrderAttrs) => {
    return new Order(attrs);
}

const Order = model<OrderAttrs, OrderModel>(`Order`, ticketSchema);

export { Order };