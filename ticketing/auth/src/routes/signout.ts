import express, { Request, Response } from "express";
import {
    TokenService,
    REFRESH_COOKIE_NAME,
} from "../services/token-service";

const router = express.Router();
router.post("/api/users/signout", async (req: Request, res: Response) => {
    const rawRefreshToken = TokenService.extractRefreshToken(req);
    if (rawRefreshToken) {
        await TokenService.revokeByRawToken(rawRefreshToken);
    }

    req.session = null;
    res.clearCookie(REFRESH_COOKIE_NAME, { path: "/api/users" });
    res.send({});
});

export { router as signoutRouter };
