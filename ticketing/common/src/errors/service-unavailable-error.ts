import { CustomError } from "./custom-error";

export class ServiceUnavailableError extends CustomError {
    statusCode = 503;

    constructor(message: string = "Service temporarily unavailable, please retry later") {
        super(message);
        Object.setPrototypeOf(this, ServiceUnavailableError.prototype);
    }

    serializeError() {
        return [{ message: this.message }];
    }
}
