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

interface OrderDoc extends mongoose.Document {
    userId: string,
    status: OrderStatus,
    expiresAt: Date,
    ticket: TicketDoc,
    version: number
}

interface OrderModel extends Model<OrderDoc> {
    build(attrs: OrderAttrs): OrderDoc;
}

// Doc Type-> TicketAttrs
// Ticketmodel inheriting all the model function along with build method we defined above
const ticketSchema = new Schema<OrderDoc, OrderModel>({
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
    // versionKey: "version",
    // optimisticConcurrency: true,
    toJSON: {
        transform(doc, ret: any) {
            ret.id = ret._id
            delete ret._id
        }
    }
})

ticketSchema.set("versionKey", "version");
ticketSchema.pre("save", function () {
    this.$where = {
        version: this.get("version")
    };
    this.increment();
});



ticketSchema.statics.build = (attrs: OrderAttrs) => {
    return new Order(attrs);
}

const Order = model<OrderDoc, OrderModel>(`Order`, ticketSchema);

export { Order };