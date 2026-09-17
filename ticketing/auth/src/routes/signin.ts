import { Request, Response, Router } from "express";
import { body } from "express-validator";
import { BadRequestError, validateRequest } from "@mehul-mrtickets/common";
import { User } from "../models/user";
import { Password } from "../services/password";
import jwt from "jsonwebtoken";

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
        const userJwt = jwt.sign({
            id: exist.id,
            email: exist.email
        }, process.env.JWT_KEY!);
        req.session = { jwt: userJwt };
        res.status(200).send({ success: true })
    })

export { router as signinRouter };

