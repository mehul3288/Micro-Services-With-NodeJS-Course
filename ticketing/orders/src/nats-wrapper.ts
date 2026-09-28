import nats, { Stan } from "node-nats-streaming";
import { randomBytes } from "node:crypto";

class NatsWrapper {
    private _client?: Stan;

    get client() {
        if (!this._client) {
            throw new Error("NATS Client not initialized");
        }
        return this._client;
    }
    connect(clusterId: string, clientId: string, url: string) {
        this._client = nats.connect(clusterId, clientId, {
            url,
        });




        return new Promise<void>((res, rej) => {
            this.client.on("connect", () => {
                console.log("Connected to NATS");
                res();
            })
            this.client.on("error", () => {
                console.log("Error in NATS");
                rej();
            })
        })
    }
}

export const natsWrapper = new NatsWrapper();