import { CustomError } from "./custom-error";

export class NotAuthorizedError extends CustomError {
    statusCode: number = 401;
    constructor(message: string = "Not authorized") {
        super(message);
        Object.setPrototypeOf(this, NotAuthorizedError.prototype)
    }
    serializeError() {
        return [{ message: this.message }]
    }
}