// import { HydratedDocument, model, Model, Schema } from "mongoose";

// interface TicketAttrs {
//     title: string,
//     price: number,
//     userId: string
// }

// interface TicketModel extends Model<TicketAttrs> {
//     build(attrs: TicketAttrs): HydratedDocument<TicketAttrs>;
// }

// // Doc Type-> TicketAttrs
// // Ticketmodel inheriting all the model function along with build method we defined above
// const ticketSchema = new Schema<TicketAttrs, TicketModel>({
//     title: {
//         type: String,
//         required: true
//     },
//     price: {
//         type: Number,
//         required: true
//     },
//     userId: {
//         type: String,
//         required: true
//     }
// }, {
//     versionKey: "version",
//     optimisticConcurrency: true,
//     toJSON: {
//         transform(doc, ret: any) {
//             ret.id = ret._id
//             delete ret._id
//             delete ret.__v
//         }
//     }
// })
// ticketSchema.set("versionKey", "version");
// ticketSchema.pre("save", function () {
//     this.$where = {
//         version: this.get("version")
//     };
//     this.increment();
// });

// ticketSchema.statics.build = (attrs: TicketAttrs) => {
//     return new Ticket(attrs);
// }

// const Ticket = model<TicketAttrs, TicketModel>(`Ticket`, ticketSchema);

// export { Ticket };

import { Document, model, Model, Schema } from "mongoose";

// Properties required to create a new Ticket
interface TicketAttrs {
    title: string;
    price: number;
    userId: string;
}

// Properties that a Ticket Document has (including version)
export interface TicketDoc extends Document {
    id: string;
    title: string;
    price: number;
    userId: string;
    version: number;
    orderId?: string
}

// Properties that the Ticket Model has
interface TicketModel extends Model<TicketDoc> {
    build(attrs: TicketAttrs): TicketDoc;
}

const ticketSchema = new Schema<TicketDoc, TicketModel>({
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
    },
    orderId: {
        type: String,
        required: false
    }
}, {
    // versionKey: "version",
    // //It will only work if the file is modified not on every save instead
    // optimisticConcurrency: true,
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

ticketSchema.statics.build = (attrs: TicketAttrs) => {
    return new Ticket(attrs);
};

const Ticket = model<TicketDoc, TicketModel>('Ticket', ticketSchema);

export { Ticket };
