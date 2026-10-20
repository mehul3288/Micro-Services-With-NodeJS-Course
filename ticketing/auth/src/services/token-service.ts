import crypto from "crypto";
import jwt from "jsonwebtoken";
import { Request } from "express";
import { NotAuthorizedError } from "@mehul-mrtickets/common";
import { RefreshToken } from "../models/refresh-token";
import { User, UserDoc } from "../models/user";

export const REFRESH_COOKIE_NAME = "refreshToken";

export const REFRESH_COOKIE_OPTIONS = {
    httpOnly: true,
    secure: process.env.NODE_ENV !== "test",
    sameSite: "strict" as const,
    path: "/api/users",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
};

export class TokenService {
    /**
     * Compute SHA-256 hash of a raw token string for secure at-rest storage.
     */
    static hashToken(rawToken: string): string {
        return crypto.createHash("sha256").update(rawToken).digest("hex");
    }

    /**
     * Generate short-lived access JWT (15 minutes).
     */
    static generateAccessToken(user: { id: string; email: string }): string {
        return jwt.sign(
            {
                id: user.id,
                email: user.email,
            },
            process.env.JWT_KEY!,
            { expiresIn: "15m" }
        );
    }

    /**
     * Generate and persist a long-lived refresh token in MongoDB (7 days) with SHA-256 hash.
     */
    static async createRefreshToken(
        userId: string,
        existingFamilyId?: string
    ): Promise<{ rawToken: string; familyId: string; expiresAt: Date }> {
        const rawToken = crypto.randomBytes(40).toString("hex");
        const tokenHash = this.hashToken(rawToken);
        const familyId = existingFamilyId || crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

        const tokenDoc = RefreshToken.build({
            userId,
            tokenHash,
            familyId,
            expiresAt,
            revokedAt: null,
            replacedBy: null,
        });
        await tokenDoc.save();

        return { rawToken, familyId, expiresAt };
    }

    /**
     * Rotate a refresh token:
     * - Validates token existence and expiry.
     * - Automatic Reuse Detection: if already revoked, invalidates the ENTIRE token family.
     * - On success: revokes old token, issues new refresh token (same family) + new 15m access token.
     */
    static async rotateRefreshToken(
        rawRefreshToken: string
    ): Promise<{ accessToken: string; newRefreshToken: string; user: UserDoc }> {
        const tokenHash = this.hashToken(rawRefreshToken);
        const tokenDoc = await RefreshToken.findOne({ tokenHash });

        if (!tokenDoc) {
            throw new NotAuthorizedError();
        }

        // --- AUTOMATIC REUSE DETECTION ---
        // If a revoked token is presented, someone is replaying a stolen/used token!
        // Immediately revoke the ENTIRE family tree so all tokens in this session are destroyed.
        if (tokenDoc.revokedAt) {
            await RefreshToken.updateMany(
                { familyId: tokenDoc.familyId, revokedAt: null },
                { revokedAt: new Date() }
            );
            throw new NotAuthorizedError();
        }

        // --- EXPIRATION CHECK ---
        if (tokenDoc.expiresAt.getTime() < Date.now()) {
            throw new NotAuthorizedError();
        }

        // --- FIND USER ---
        const user = await User.findById(tokenDoc.userId);
        if (!user) {
            throw new NotAuthorizedError();
        }

        // --- ROTATE: ISSUE NEW REFRESH TOKEN IN SAME FAMILY ---
        const { rawToken: newRefreshToken } = await this.createRefreshToken(
            user.id,
            tokenDoc.familyId
        );

        // Mark old token as revoked and link replacedBy hash
        tokenDoc.revokedAt = new Date();
        tokenDoc.replacedBy = this.hashToken(newRefreshToken);
        await tokenDoc.save();

        // Issue new short-lived access JWT
        const accessToken = this.generateAccessToken(user);

        return { accessToken, newRefreshToken, user };
    }

    /**
     * Revoke all tokens belonging to the given raw token's family (used during signout).
     */
    static async revokeByRawToken(rawRefreshToken: string): Promise<void> {
        const tokenHash = this.hashToken(rawRefreshToken);
        const tokenDoc = await RefreshToken.findOne({ tokenHash });
        if (tokenDoc) {
            await RefreshToken.updateMany(
                { familyId: tokenDoc.familyId, revokedAt: null },
                { revokedAt: new Date() }
            );
        }
    }

    /**
     * Helper to extract refresh token from request body OR cookie.
     */
    static extractRefreshToken(req: Request): string | null {
        if (req.body && typeof req.body.refreshToken === "string" && req.body.refreshToken.trim().length > 0) {
            return req.body.refreshToken.trim();
        }

        const cookieHeader = req.headers.cookie;
        if (!cookieHeader) return null;

        const cookies = cookieHeader.split(";").map((c) => c.trim());
        for (const cookie of cookies) {
            const [k, ...v] = cookie.split("=");
            if (k === REFRESH_COOKIE_NAME) {
                return decodeURIComponent(v.join("="));
            }
        }

        return null;
    }
}
