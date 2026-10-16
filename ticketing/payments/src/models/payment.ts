import mongoose from "mongoose";
import { PaymentStatus } from "@mehul-mrtickets/common";

interface PaymentAttrs {
    orderId: string;
    stripeId: string;
    status?: PaymentStatus;
}

interface PaymentDoc extends mongoose.Document {
    id: string;
    orderId: string;
    stripeId: string;
    status: PaymentStatus;
}

interface PaymentModel extends mongoose.Model<PaymentDoc> {
    build(attrs: PaymentAttrs): PaymentDoc;
}

const paymentSchema = new mongoose.Schema(
    {
        orderId: {
            type: String,
            required: true,
            unique: true,
        },
        stripeId: {
            type: String,
            required: true,
        },
        status: {
            type: String,
            enum: Object.values(PaymentStatus),
            default: PaymentStatus.Succeeded,
            required: true,
        },
    },
    {
        toJSON: {
            transform(doc, ret: any) {
                ret.id = ret._id;
                delete ret._id;
            },
        },
    }
);

paymentSchema.statics.build = (attrs: PaymentAttrs) => {
    return new Payment(attrs);
};

const Payment = mongoose.model<PaymentDoc, PaymentModel>("Payment", paymentSchema);

export { Payment };
