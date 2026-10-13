import { Server } from "http";

export type Closer = () => Promise<void>;

export const shutdownState = {
    isShuttingDown: false,
};

export const registerGracefulShutdown = (server: Server, closers: Closer[] = []): void => {
    const shutdown = async () => {
        if (shutdownState.isShuttingDown) return;
        shutdownState.isShuttingDown = true;

        console.log("Graceful shutdown signal received. Draining connections...");

        // Safety timeout so a stuck connection cannot prevent the pod from terminating
        setTimeout(() => {
            console.error("Graceful shutdown timeout exceeded (20s). Forcing termination.");
            process.exit(1);
        }, 20 * 1000).unref();

        // Stop accepting new HTTP requests
        server.close(async () => {
            console.log("HTTP server closed to new requests.");
        });

        // Run cleanup closers (close broker, disconnect mongoose)
        for (const close of closers) {
            try {
                await close();
            } catch (err) {
                console.error("Error during resource closure:", err);
            }
        }

        console.log("Graceful shutdown complete. Exiting cleanly.");
        process.exit(0);
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
};
