import { Schema, model, Model, HydratedDocument } from "mongoose";
import { Password } from "../services/password";

// ============================================================================
// 1. UserAttrs Interface
// ============================================================================
// ROLE: Describes the properties required to create a new User.
// WHY WE NEED IT: 
// When creating a new user, we want TypeScript to strictly validate the input.
// If someone passes misspelled properties (e.g., { emal, psswrd }), TypeScript
// will flag it as an error at compile-time instead of silently failing at runtime.
interface UserAttrs {
    email: string;
    password: string;
}

// ============================================================================
// 2. UserModel Interface
// ============================================================================
// ROLE: Describes the methods/properties that the overall User Model (the class) possesses.
// WHY WE NEED IT:
// - Extends Mongoose's built-in `Model<UserAttrs>`, so it inherits standard collection
//   methods like `User.find()`, `User.findOne()`, `User.findById()`, etc.
// - Declares our custom static method `build(attrs: UserAttrs)`.
// - `HydratedDocument<UserAttrs>` is a modern Mongoose helper type representing a single 
//   User document instance with all Mongoose document methods (like `.save()`, `._id`, etc.) 
//   plus our `UserAttrs` properties attached to it.
interface UserModel extends Model<UserAttrs> {
    build(attrs: UserAttrs): HydratedDocument<UserAttrs>;
}

// ============================================================================
// 3. User Schema Definition
// ============================================================================
// ROLE: The runtime blueprint for MongoDB telling it what fields a user document has.
// WHY WE NEED IT:
// - `new Schema<UserAttrs, UserModel>` provides TypeScript generic types:
//     * Generic 1 (`UserAttrs`): Tells Mongoose the shape of document data.
//     * Generic 2 (`UserModel`): Tells Mongoose about custom static methods on the Model.
// - `type: String` and `required: true` enforce database-level validation in MongoDB.
const userSchema = new Schema<UserAttrs, UserModel>(
    {
        email: {
            type: String,
            required: true,
        },
        password: {
            type: String,
            required: true,
        },
    },
    {
        //toJSON will transform the object which is sent to client
        // we don't want to send password and _id to client
        toJSON: {
            transform(doc, ret: Record<string, any>) {
                ret.id = ret._id;
                delete ret._id;
                delete ret.password;
                delete ret.__v;
            },
        },
    }
);

// ============================================================================
// 4. Custom Static Method: .build()
// ============================================================================
// ROLE: A factory function attached directly to the User Model.
// WHY WE NEED IT:
// By default, Mongoose's `new User({...})` constructor is loosely typed to allow internal
// document hydration. By routing all creation through `User.build(attrs)`, TypeScript
// strictly validates the arguments against the `UserAttrs` interface.

userSchema.pre("save", async function () {
    // here this will be the user document object
    // Only hash the password if it has been modified (not on updates)
    if (this.isModified("password")) {
        const hashed = await Password.toHash(this.get("password") as string);
        this.set("password", hashed);
    }
});

userSchema.statics.build = (attrs: UserAttrs) => {
    return new User(attrs);
};

// ============================================================================
// 5. Creating the Model
// ============================================================================
// ROLE: Compiles the schema into an actual Mongoose Model class.
// WHY WE NEED IT:
// - `"User"`: The singular name of the model. Mongoose automatically creates or connects
//   to the pluralized collection name `"users"` in the MongoDB database.
// - Generics `<UserAttrs, UserModel>` ensure the returned `User` object is fully typed
//   with all Mongoose query methods and our custom `.build()` static method.
const User = model<UserAttrs, UserModel>("User", userSchema);

// ============================================================================
// 6. Exporting the Model
// ============================================================================
// ROLE: Makes the `User` model available to other files across the microservice
// (such as signup, signin, and current-user route handlers).
export { User };