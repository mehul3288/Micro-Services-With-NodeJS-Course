import mongoose, { Document, Model, Schema } from "mongoose";

export interface OutboxEventAttrs {
    eventId: string;
    topic: string;
    key: string;
    eventType: string;
    payload: string;
    headers?: Record<string, string>;
}

export interface OutboxEventDoc extends Document {
    eventId: string;
    topic: string;
    key: string;
    eventType: string;
    payload: string;
    headers?: Record<string, string>;
    publishedAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface OutboxEventModel extends Model<OutboxEventDoc> {
    build(attrs: OutboxEventAttrs): OutboxEventDoc;
}

const outboxEventSchema = new Schema(
    {
        eventId: {
            type: String,
            required: true,
            unique: true,
        },
        topic: {
            type: String,
            required: true,
        },
        key: {
            type: String,
            required: true,
        },
        eventType: {
            type: String,
            required: true,
        },
        payload: {
            type: String,
            required: true,
        },
        headers: {
            type: Map,
            of: String,
            default: {},
        },
        publishedAt: {
            type: Date,
            default: null,
        },
    },
    {
        timestamps: true,
        toJSON: {
            transform(doc, ret: any) {
                ret.id = ret._id;
                delete ret._id;
            },
        },
    }
);

// Index for polling pending events efficiently in oldest-first order
outboxEventSchema.index({ publishedAt: 1, _id: 1 });

// TTL index: delete published outbox events after 7 days
outboxEventSchema.index(
    { publishedAt: 1 },
    { expireAfterSeconds: 7 * 24 * 60 * 60, partialFilterExpression: { publishedAt: { $ne: null } } }
);

outboxEventSchema.statics.build = (attrs: OutboxEventAttrs) => {
    return new OutboxEvent(attrs);
};

export const OutboxEvent = mongoose.model<OutboxEventDoc, OutboxEventModel>(
    "OutboxEvent",
    outboxEventSchema
);
