import mongoose, { Schema } from "mongoose";

interface TicketAttrs {
    id: string;
    title: string;
    price: number;
}

export interface TicketDoc extends mongoose.Document {
    id: string;
    title: string;
    price: number;
    version: number;
    reservedBy?: string | null;
}

interface TicketModel extends mongoose.Model<TicketDoc> {
    findByEvent(event: { id: string; version: number }): Promise<TicketDoc | null>;
    build(attrs: TicketAttrs): TicketDoc;
    reserve(ticketId: string, orderId: string): Promise<TicketDoc | null>;
    release(ticketId: string, orderId: string): Promise<any>;
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
    },
    reservedBy: {
        type: String,
        default: null
    }
}, {
    toJSON: {
        transform(doc, ret: any) {
            ret.id = ret._id;
            delete ret._id;
            delete ret.__v;
        }
    }
});

ticketSchema.set("versionKey", "version");
ticketSchema.pre("save", function () {
    this.$where = {
        version: this.get("version")
    };
    this.increment();
});

ticketSchema.statics.reserve = (ticketId: string, orderId: string) => {
    return Ticket.findOneAndUpdate(
        { _id: ticketId, reservedBy: null },
        { $set: { reservedBy: orderId } },
        { returnDocument: "after" }
    );
};

ticketSchema.statics.release = (ticketId: string, orderId: string) => {
    return Ticket.updateOne(
        { _id: ticketId, reservedBy: orderId },
        { $set: { reservedBy: null } }
    );
};

ticketSchema.statics.findByEvent = (event: { id: string; version: number }) => {
    const { id, version } = event;
    return Ticket.findOne({
        _id: id,
        version: version - 1
    });
};

ticketSchema.statics.build = (attrs: TicketAttrs) => {
    return new Ticket({
        _id: attrs.id,
        title: attrs.title,
        price: attrs.price
    });
};

const Ticket = mongoose.model<TicketDoc, TicketModel>("Ticket", ticketSchema);

export { Ticket };