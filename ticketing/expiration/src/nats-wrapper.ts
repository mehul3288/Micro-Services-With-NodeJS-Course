import nats, { Stan } from "node-nats-streaming";

class NatsWrapper {
    private _client?: Stan;
    private _isConnected = false;

    get client() {
        if (!this._client) {
            throw new Error("NATS Client not initialized");
        }
        return this._client;
    }

    get isConnected(): boolean {
        return this._isConnected;
    }

    connect(clusterId: string, clientId: string, url: string) {
        this._client = nats.connect(clusterId, clientId, {
            url,
        });

        return new Promise<void>((res, rej) => {
            this.client.on("connect", () => {
                this._isConnected = true;
                console.log("Connected to NATS");
                res();
            });
            this.client.on("close", () => {
                this._isConnected = false;
                console.log("NATS connection closed");
            });
            this.client.on("error", (err) => {
                this._isConnected = false;
                console.log("Error in NATS", err);
                rej(err);
            });
        });
    }
}

export const natsWrapper = new NatsWrapper();