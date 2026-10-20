import express, { Request, Response } from "express";
import { NotAuthorizedError } from "@mehul-mrtickets/common";
import {
    TokenService,
    REFRESH_COOKIE_NAME,
    REFRESH_COOKIE_OPTIONS,
} from "../services/token-service";

const router = express.Router();

router.post("/api/users/refresh", async (req: Request, res: Response) => {
    const rawRefreshToken = TokenService.extractRefreshToken(req);

    if (!rawRefreshToken) {
        throw new NotAuthorizedError();
    }

    const { accessToken, newRefreshToken, user } =
        await TokenService.rotateRefreshToken(rawRefreshToken);

    // Update access token in session cookie (used across all downstream microservices)
    req.session = { jwt: accessToken };

    // Set updated rotated refresh token in dedicated path-restricted HTTP-only cookie
    res.cookie(REFRESH_COOKIE_NAME, newRefreshToken, REFRESH_COOKIE_OPTIONS);

    res.status(200).send({
        id: user.id,
        email: user.email,
        refreshToken: newRefreshToken,
    });
});

export { router as refreshRouter };
