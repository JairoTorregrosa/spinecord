// Prints the SHA-256 of a token, the form PRINCIPALS stores. With no argument it makes a new random token.
//   bun scripts/hash-token.ts            → new token + its hash
//   bun scripts/hash-token.ts <token>    → hash of that token
import { createHash, randomBytes } from "node:crypto";

const token = process.argv[2] ?? randomBytes(24).toString("base64url");
console.log(JSON.stringify({ token, token_sha256: createHash("sha256").update(token).digest("hex") }, null, 2));
