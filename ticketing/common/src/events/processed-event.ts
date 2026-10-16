import mongoose, { Document, Model, Schema } from "mongoose";

export interface ProcessedEventAttrs {
    eventId: string;
    consumerGroup: string;
    processedAt?: Date;
}

export interface ProcessedEventDoc extends Document {
    eventId: string;
    consumerGroup: string;
    processedAt: Date;
    createdAt: Date;
    updatedAt: Date;
}

export interface ProcessedEventModel extends Model<ProcessedEventDoc> {
    build(attrs: ProcessedEventAttrs): ProcessedEventDoc;
}

const processedEventSchema = new Schema(
    {
        eventId: {
            type: String,
            required: true,
        },
        consumerGroup: {
            type: String,
            required: true,
        },
        processedAt: {
            type: Date,
            default: Date.now,
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

// Compound unique index: guarantees exactly-once processing per consumer group
processedEventSchema.index({ eventId: 1, consumerGroup: 1 }, { unique: true });

// TTL index: delete processed event tracking records after 7 days
processedEventSchema.index({ processedAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

processedEventSchema.statics.build = (attrs: ProcessedEventAttrs) => {
    return new ProcessedEvent(attrs);
};

export const ProcessedEvent = mongoose.model<ProcessedEventDoc, ProcessedEventModel>(
    "ProcessedEvent",
    processedEventSchema
);
