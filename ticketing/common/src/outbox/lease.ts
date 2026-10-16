import mongoose, { Document, Model, Schema } from "mongoose";

export interface LeaseDoc extends Document<string> {
    _id: string;
    holder: string;
    expiresAt: Date;
    updatedAt: Date;
}

export interface LeaseModel extends Model<LeaseDoc> {}

const leaseSchema = new Schema(
    {
        _id: {
            type: String,
            required: true,
        },
        holder: {
            type: String,
            required: true,
        },
        expiresAt: {
            type: Date,
            required: true,
        },
    },
    {
        timestamps: true,
    }
);

export const Lease = mongoose.model<LeaseDoc, LeaseModel>("Lease", leaseSchema);

export async function acquireLease(
    leaseName: string,
    holderId: string,
    ttlMs = 10000
): Promise<boolean> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);

    try {
        const lease = await Lease.findOneAndUpdate(
            {
                _id: leaseName,
                $or: [
                    { expiresAt: { $lt: now } }, // Lease expired; claimable
                    { holder: holderId },        // We already hold it; renew
                ],
            },
            {
                $set: {
                    holder: holderId,
                    expiresAt,
                },
            },
            {
                upsert: true,
                returnDocument: "after",
            }
        );

        return lease?.holder === holderId;
    } catch (err) {
        // E11000 duplicate key race on upsert means another replica won the lease
        return false;
    }
}
