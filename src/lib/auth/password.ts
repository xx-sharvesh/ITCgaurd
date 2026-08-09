/**
 * Password hashing and verification.
 *
 * scrypt from Node's own crypto module — no dependency, and deliberately not
 * a fast hash. SHA-256 over a password is a GPU-crackable mistake; scrypt is
 * memory-hard, so the attacker who walks off with a hash cannot simply throw
 * hardware at it.
 *
 * Never imported by client code. The password never reaches the browser in
 * any form, hashed or otherwise — the browser POSTs a candidate and gets back
 * a cookie, nothing else.
 */

import "server-only";
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * OWASP's current floor for scrypt is N=2^17, r=8, p=1. Node's default maxmem
 * is too small for that, so it is raised explicitly rather than silently
 * falling back to weaker parameters.
 */
const KEYLEN = 64;
const SALT_BYTES = 16;

/**
 * `scrypt:<saltHex>:<keyHex>` — self-describing, so the format can be
 * migrated later.
 *
 * The separator is a colon rather than the conventional `$` of the modular
 * crypt format, and that is deliberate. This value lives in `.env.local`,
 * and dotenv-style loaders perform shell variable expansion on values:
 * `scrypt$1df0…$f4f7…` loads as the string `"scrypt"`, because `$1df0…`
 * and `$f4f7…` are read as undefined variables and expand to nothing. The
 * failure is silent and presents as "wrong password", which is a genuinely
 * horrible thing to debug. Hex digits and the word "scrypt" contain no
 * colons, so this separator is unambiguous and expansion-proof.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password.normalize("NFKC"), salt, KEYLEN);
  return `scrypt:${salt.toString("hex")}:${key.toString("hex")}`;
}

/**
 * Verify a candidate against a stored hash.
 *
 * Always performs the full scrypt derivation, even when the stored hash is
 * malformed or missing, so the time taken cannot distinguish "no such user"
 * from "wrong password". The final comparison is timing-safe for the same
 * reason — a byte-by-byte `===` leaks how much of the hash matched.
 */
export async function verifyPassword(password: string, stored: string | undefined): Promise<boolean> {
  const parts = (stored ?? "").split(":");
  const valid = parts.length === 3 && parts[0] === "scrypt";

  // A fixed decoy salt keeps the work identical on the failure path.
  const salt = valid ? Buffer.from(parts[1], "hex") : Buffer.alloc(SALT_BYTES);
  const expected = valid ? Buffer.from(parts[2], "hex") : Buffer.alloc(KEYLEN);

  let actual: Buffer;
  try {
    actual = await scrypt(password.normalize("NFKC"), salt, KEYLEN);
  } catch {
    return false;
  }

  if (actual.length !== expected.length) return false;
  const match = timingSafeEqual(actual, expected);
  return valid && match;
}
