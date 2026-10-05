import { OrderStatus } from "@mehul-mrtickets/common";
import mongoose, { Schema } from "mongoose";

interface OrderAttrs {
    id: string;
    version: number;
    userId: string;
    price: number;
    status: OrderStatus;
}

interface OrderDoc extends mongoose.Document {
    version: number;
    userId: string;
    price: number;
    status: OrderStatus;
}

interface OrderModel extends mongoose.Model<OrderDoc> {
    build(attrs: OrderAttrs): OrderDoc;
}

const orderSchema = new Schema({
    userId: {
        type: String,
        required: true
    },
    price: {
        type: Number,
        required: true
    },
    status: {
        type: String,
        required: true,
        // enum: Object.values(OrderStatus),
        // default: OrderStatus.Created
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

orderSchema.set("versionKey", "version");
orderSchema.pre("save", function () {
    this.$where = {
        version: this.get("version")
    };
    this.increment();
});

orderSchema.statics.build = (attrs: OrderAttrs) => {
    return new Order({
        _id: attrs.id,
        version: attrs.version,
        userId: attrs.userId,
        price: attrs.price,
        status: attrs.status
    })
}

const Order = mongoose.model<OrderDoc, OrderModel>("Order", orderSchema);
export { Order };