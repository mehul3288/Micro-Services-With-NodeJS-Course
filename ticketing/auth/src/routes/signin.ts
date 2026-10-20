import { Request, Response, Router } from "express";
import { body } from "express-validator";
import { BadRequestError, validateRequest } from "@mehul-mrtickets/common";
import { User } from "../models/user";
import { Password } from "../services/password";
import {
    TokenService,
    REFRESH_COOKIE_NAME,
    REFRESH_COOKIE_OPTIONS,
} from "../services/token-service";

const router = Router();
router.post("/api/users/signin",
    [body('email').isEmail().withMessage('Invalid email'), body('password').trim().notEmpty().withMessage('Password is required')], validateRequest,
    async (req: Request, res: Response) => {

        const { email, password } = req.body;
        const exist = await User.findOne({ email });
        if (!exist) {
            throw new BadRequestError("Invalid Credentials")
        }
        const isPasswordValid = await Password.compare(exist.password, password);
        if (!isPasswordValid) {
            throw new BadRequestError("Invalid Credentials")
        }
        const userJwt = TokenService.generateAccessToken(exist);
        const { rawToken: refreshToken } = await TokenService.createRefreshToken(exist.id);

        req.session = { jwt: userJwt };
        res.cookie(REFRESH_COOKIE_NAME, refreshToken, REFRESH_COOKIE_OPTIONS);

        res.status(200).send({
            success: true,
            id: exist.id,
            email: exist.email,
            refreshToken,
        });
    })

export { router as signinRouter };

