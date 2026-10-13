import express, { Request, Response, Router } from "express";

export type ReadinessCheck = () => boolean;

export const healthRouter = (readinessChecks: ReadinessCheck[] = []): Router => {
    const router = express.Router();

    router.get("/healthz/live", (req: Request, res: Response) => {
        res.status(200).send({ status: "ok" });
    });

    router.get("/healthz/ready", (req: Request, res: Response) => {
        const isReady = readinessChecks.every((check) => check());
        res.status(isReady ? 200 : 503).send({ status: isReady ? "ready" : "not-ready" });
    });

    return router;
};
