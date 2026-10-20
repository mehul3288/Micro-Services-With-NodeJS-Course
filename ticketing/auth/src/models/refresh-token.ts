import mongoose from "mongoose";

// Interface describing attributes required to create a RefreshToken
interface RefreshTokenAttrs {
    userId: string;
    tokenHash: string;
    familyId: string;
    expiresAt: Date;
    revokedAt?: Date | null;
    replacedBy?: string | null;
}

// Interface describing the RefreshToken document properties
export interface RefreshTokenDoc extends mongoose.Document {
    userId: string;
    tokenHash: string;
    familyId: string;
    expiresAt: Date;
    revokedAt?: Date | null;
    replacedBy?: string | null;
    createdAt: Date;
}

// Interface describing the RefreshToken model
interface RefreshTokenModel extends mongoose.Model<RefreshTokenDoc> {
    build(attrs: RefreshTokenAttrs): RefreshTokenDoc;
}

const refreshTokenSchema = new mongoose.Schema(
    {
        userId: {
            type: String,
            required: true,
            index: true,
        },
        tokenHash: {
            type: String,
            required: true,
            unique: true,
            index: true,
        },
        familyId: {
            type: String,
            required: true,
            index: true,
        },
        expiresAt: {
            type: Date,
            required: true,
        },
        revokedAt: {
            type: Date,
            default: null,
        },
        replacedBy: {
            type: String,
            default: null,
        },
        createdAt: {
            type: Date,
            default: Date.now,
        },
    },
    {
        toJSON: {
            transform(doc, ret: Record<string, any>) {
                // Remove internal sensitive fields when serialized to JSON
                delete ret.tokenHash;
                ret.id = ret._id;
                delete ret._id;
                delete ret.__v;
            },
        },
    }
);

// TTL index to automatically purge expired refresh tokens from MongoDB
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

refreshTokenSchema.statics.build = (attrs: RefreshTokenAttrs) => {
    return new RefreshToken(attrs);
};

const RefreshToken = mongoose.model<RefreshTokenDoc, RefreshTokenModel>(
    "RefreshToken",
    refreshTokenSchema
);

export { RefreshToken };
