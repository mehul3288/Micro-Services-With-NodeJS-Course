import { CustomError } from "./custom-error";

export class BadRequestError extends CustomError {
    statusCode = 400;

    // super(message) must be called before accessing this because BadRequestError extends the built-in Error class. In a derived class constructor, JavaScript does not allow us to access this until the parent constructor has been called.
    // super(message) calls the Error constructor, initializes the parent Error object, and sets the message property. After that, this is available, so we can use Object.setPrototypeOf(this, BadRequestError.prototype) to ensure the prototype chain correctly identifies the object as a BadRequestError.
    constructor(message: string) {
        // super is kind of executed before the message we have received is assigned to this error class so if we pass this.message inside super it wouldn't have created the property at this point in time 
        super(message);
        Object.setPrototypeOf(this, BadRequestError.prototype);
    }

    serializeError() {
        return [{ message: this.message }]
    }
}