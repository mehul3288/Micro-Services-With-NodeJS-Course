import express, { Request, Response } from "express";
import { body } from "express-validator";
import { BadRequestError, validateRequest } from "@mehul-mrtickets/common";
import { User } from "../models/user";
import {
    TokenService,
    REFRESH_COOKIE_NAME,
    REFRESH_COOKIE_OPTIONS,
} from "../services/token-service";

const router = express.Router();
router.post(
    "/api/users/signup",
    [
        body("email").isEmail().withMessage("Email must be valid!"),
        body("password")
            .trim()
            .isLength({ min: 4, max: 20 })
            .withMessage("Password must be between 4 to 20 characters!"),
    ],
    validateRequest,
    async (req: Request, res: Response) => {
        const { email, password } = req.body;
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            console.log("Email in use");
            throw new BadRequestError("Email in use");
        }
        const user = User.build({ email, password });
        await user.save();

        // Generate short-lived access JWT (15m) and long-lived refresh token (7d)
        const userJwt = TokenService.generateAccessToken(user);
        const { rawToken: refreshToken } = await TokenService.createRefreshToken(user.id);

        // Store access token in session cookie
        req.session = { jwt: userJwt };

        // Store refresh token in dedicated HTTP-only cookie
        res.cookie(REFRESH_COOKIE_NAME, refreshToken, REFRESH_COOKIE_OPTIONS);

        res.status(201).send(user);
    }
);

export { router as signupRouter };

