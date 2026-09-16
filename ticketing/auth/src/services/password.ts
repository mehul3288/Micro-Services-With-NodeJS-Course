// export abstract class HashPassword{
//     abstract toHash(password:string):Promise<string>;
//     abstract compare(storedPassword:string,suppliedPassword:string):Promise<boolean>;
// }

import { scrypt, randomBytes, timingSafeEqual } from "crypto";
import { promisify } from 'util';
const scryptAsync = promisify(scrypt);

export class Password {
    static async toHash(password: string) {
        const salt = randomBytes(8).toString('hex');
        const buf = (await scryptAsync(password, salt, 64)) as Buffer;
        return `${buf.toString('hex')}.${salt}`;
    }

    static async compare(storedPassword: string, suppliedPassword: string) {
        const [hashedPassword, salt] = storedPassword.split('.');
        const buf = (await scryptAsync(suppliedPassword, salt, 64)) as Buffer;
        return timingSafeEqual(buf, Buffer.from(hashedPassword, 'hex'));
    }
}

// Buffer:
// ### What is a Buffer in Node.js?

// A **Buffer** is a global class in Node.js used to handle and manipulate **raw binary data (bytes)** directly in memory.

// ---

// ### Why do we need Buffers?

// 1. **JavaScript originally only handled text/strings:**
//    Standard JavaScript in browsers was designed for strings, numbers, and objects. It didn't have a way to handle raw binary data (like reading files, images, network TCP packets, or cryptographic hashes).
// 2. **Node.js works with system resources:**
//    When Node.js reads a file from disk, receives network packets, or hashes a password, that data arrives as a stream of **raw bytes (0s and 1s)**.
// 3. **Buffers allocate memory outside V8:**
//    Buffers are allocated as fixed-size raw memory chunks outside the V8 JavaScript garbage collection heap for high performance.

// ---

// ### What does a Buffer look like?

// A Buffer is essentially an array of bytes. Each byte is an integer between `0` and `255` (represented in **hexadecimal** `00` to `ff`):

// ```javascript
// const buf = Buffer.from('Hello');
// console.log(buf);
// // Output: <Buffer 48 65 6c 6c 6f>
// // 48 = 'H', 65 = 'e', 6c = 'l', 6c = 'l', 6f = 'o' in ASCII/Hex
// ```

// ---

// ### How Buffers are used in your `password.ts` code:

// In your hashing logic:

// ```typescript
// // 1. scrypt produces 64 raw binary bytes of cryptographic output:
// const buf = (await scryptAsync(password, salt, 64)) as Buffer;
// // buf is: <Buffer 3a f8 91 2b c4 7d ...>

// // 2. We convert the raw binary bytes to a readable Hex string to store in MongoDB:
// const hexString = buf.toString('hex');
// // "3af8912bc47d..."

// // 3. When comparing passwords, we convert the stored hex string back into a Buffer:
// const storedBuf = Buffer.from(hashedPassword, 'hex');

// // 4. timingSafeEqual compares the two binary Buffers byte-by-byte:
// timingSafeEqual(buf, storedBuf);
// ```

// ---

// ### Common Buffer Conversions:

// | Operation | Code | Example Output |
// | :--- | :--- | :--- |
// | **String to Buffer** | `Buffer.from('hello', 'utf-8')` | `<Buffer 68 65 6c 6c 6f>` |
// | **Buffer to Hex String** | `buf.toString('hex')` | `'68656c6c6f'` |
// | **Buffer to Base64 String** | `buf.toString('base64')` | `'aGVsbG8='` |
// | **Hex String to Buffer** | `Buffer.from('68656c6c6f', 'hex')` | `<Buffer 68 65 6c 6c 6f>` |


// timingSafeEqual:
// Normal comparison

// You might normally do:

// if (token === expectedToken) {
//   // valid
// }

// The problem is that normal string comparison can potentially take different amounts of time depending on where the values differ.

// For example:

// "abcdef123"
// "abcxyz123"
//    ↑
// difference here

// An attacker could potentially make many requests and measure tiny timing differences to learn information about the secret.

// timingSafeEqual()

// Node provides:

// import { timingSafeEqual } from "crypto";

// const a = Buffer.from("secret123");
// const b = Buffer.from("secret123");

// if (timingSafeEqual(a, b)) {
//   console.log("Match");
// }

// It performs the comparison in a way designed to make the execution time independent of the contents of the values, reducing timing side-channel attacks.

// So you may see:

// const a = Buffer.from(token);
// const b = Buffer.from(expectedToken);

// if (a.length !== b.length) {
//     return false;
// }

// return timingSafeEqual(a, b);
// Interview explanation

// timingSafeEqual() is a cryptographic comparison function in Node.js that compares two byte sequences while minimizing timing differences.It's useful when comparing secrets such as tokens, signatures, or hashes because normal equality checks can potentially expose information through timing side channels.