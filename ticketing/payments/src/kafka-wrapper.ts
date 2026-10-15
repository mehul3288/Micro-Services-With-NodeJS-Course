import { Kafka, Producer } from "kafkajs";

class KafkaWrapper {
    private _kafka?: Kafka;
    private _producer?: Producer;
    private _isConnected = false;

    get kafka(): Kafka {
        if (!this._kafka) {
            throw new Error("Kafka client not initialized");
        }
        return this._kafka;
    }

    get producer(): Producer {
        if (!this._producer) {
            throw new Error("Kafka producer not initialized");
        }
        return this._producer;
    }

    get isConnected(): boolean {
        return this._isConnected;
    }

    async connect(clientId: string, brokers: string[]): Promise<void> {
        this._kafka = new Kafka({ clientId, brokers });
        this._producer = this._kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
        await this._producer.connect();
        this._isConnected = true;
        console.log("Connected to Kafka producer");
    }

    async disconnect(): Promise<void> {
        if (this._producer) {
            await this._producer.disconnect();
            this._isConnected = false;
            console.log("Kafka producer disconnected");
        }
    }
}

export const kafkaWrapper = new KafkaWrapper();
