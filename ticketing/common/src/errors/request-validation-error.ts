import { ValidationError } from "express-validator";
import { CustomError } from "./custom-error";

//Why we are using abstract class instead of interface is because if we use interface we are going to implement and not extend so in our error-handler middleware we will have to check if err instance of all the possible types of errors we are going to handle in our app so instead of writing this much checks for every error we can just extend and abstract class customError and then in our middleware we can just check if err instance of  and as all the custom error class will be implementing that abstract class eventually they all will have same structure and will be instance of CustomErrors class only so we will just need to add one if statement instead of many 

// We use an abstract class instead of an interface because we want to leverage class inheritance and runtime instanceof checks.
// If we used an interface, the custom errors would implement that interface, but interfaces don't exist at runtime in TypeScript. So in our error-handling middleware, we couldn't simply do err instanceof CustomError. We would potentially need to check for each specific error type individually.
// By having all our custom error classes extend a common abstract CustomError class, they share the same structure and, more importantly, they are all runtime instances of CustomError.
// So our middleware can simply do:
// if (err instanceof CustomError) {
//   // handle all our custom application errors
// }
// This gives us a single common check instead of having separate instanceof checks for every custom error type.

// interface CustomErrors {
//     statusCode: number
//     serializeError(): {
//         message: string;
//         field?: string;
//     }[]
// }

export class RequestValidationError extends CustomError {
    statusCode = 400;
    constructor(public errors: ValidationError[]) {
        super('Invalid request parameters');
        Object.setPrototypeOf(this, RequestValidationError.prototype);

    }

    serializeError() {
        return this.errors.map((error) => {
            if (error.type === 'field') {
                return { message: error.msg, field: error.path };
            }
            return { message: error.msg }
        });
    }

}