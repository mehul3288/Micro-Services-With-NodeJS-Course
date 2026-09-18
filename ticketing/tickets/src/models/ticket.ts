import { HydratedDocument, model, Model, Schema } from "mongoose";

interface TicketAttrs {
    title: string,
    price: number,
    userId: string
}

interface TicketModel extends Model<TicketAttrs> {
    build(attrs: TicketAttrs): HydratedDocument<TicketAttrs>;
}

// Doc Type-> TicketAttrs
// Ticketmodel inheriting all the model function along with build method we defined above
const ticketSchema = new Schema<TicketAttrs, TicketModel>({
    title: {
        type: String,
        required: true
    },
    price: {
        type: Number,
        required: true
    },
    userId: {
        type: String,
        required: true
    }
}, {
    toJSON: {
        transform(doc, ret: any) {
            ret.id = ret._id
            delete ret._id
            delete ret.__v
        }
    }
})

ticketSchema.statics.build = (attrs: TicketAttrs) => {
    return new Ticket(attrs);
}

const Ticket = model<TicketAttrs, TicketModel>(`Ticket`, ticketSchema);

export { Ticket };