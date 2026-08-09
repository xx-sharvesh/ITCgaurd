/**
 * Stateless signed sessions.
 *
 * A session is `<payloadB64url>.<hmacB64url>`. There is no server-side session
 * store because there is no database yet, and inventing one in memory would
 * silently log every user out on each deploy or serverless cold start.
 *
 * The security property that matters: the payload is signed, not encrypted.
 * A user can read their own session contents — that is fine, it holds a
 * username and two timestamps, nothing secret — but cannot alter them without
 * the server's secret. Anything genuinely sensitive stays out of it.
 *
 * RUNTIME NOTE: built on Web Crypto (`crypto.subtle`), not `node:crypto`,
 * because `middleware.ts` is the enforcement point for auth and Next runs
 * middleware on the Edge runtime, where Node's crypto module does not exist.
 * Web Crypto is present in both Edge and Node 18+, so one implementation
 * serves both. This is why every function here is async — subtle.sign is
 * promise-based and there is no synchronous equivalent.
 */

import { cookies } from "next/headers";

const SESSION_COOKIE = "itcguard_session";
const CSRF_COOKIE = "itcguard_csrf";

/** Eight hours: a working day. Long enough not to nag, short enough that a walked-away laptop expires. */
const SESSION_TTL_SECONDS = 8 * 60 * 60;

export interface SessionPayload {
  /** Username this session belongs to. */
  sub: string;
  /** Issued-at, epoch seconds. */
  iat: number;
  /** Expiry, epoch seconds. */
  exp: number;
}

/**
 * Per-process fallback secret for development only.
 *
 * Regenerated on every server start, so restarting invalidates sessions —
 * a small annoyance, and a large safeguard against this value ever being
 * mistaken for something usable in production.
 */
const devSecret = crypto.getRandomValues(new Uint8Array(32));

function secretBytes(): Uint8Array {
  const value = process.env.AUTH_SECRET;

  if (!value || value.length < 32) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "AUTH_SECRET is missing or shorter than 32 characters. Refusing to run with a guessable session key.",
      );
    }
    return devSecret;
  }

  return new TextEncoder().encode(value);
}

let cachedKey: CryptoKey | null = null;
let cachedFor: string | null = null;

async function hmacKey(): Promise<CryptoKey> {
  const raw = secretBytes();
  const fingerprint = String(raw.length) + ":" + (process.env.AUTH_SECRET ?? "dev");

  // Importing the key on every request is measurable at login-rate volumes
  // and pointless — the secret does not change while the process lives.
  if (cachedKey && cachedFor === fingerprint) return cachedKey;

  cachedKey = await crypto.subtle.importKey(
    "raw",
    raw as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  cachedFor = fingerprint;
  return cachedKey;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function sign(payloadB64: string): Promise<string> {
  const key = await hmacKey();
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return toBase64Url(new Uint8Array(sig));
}

/**
 * Constant-time string comparison.
 *
 * Web Crypto has no `timingSafeEqual`, so this accumulates differences with
 * XOR and only inspects the total at the end. An early-exit `===` leaks how
 * many leading bytes matched, which is enough to forge a signature one byte
 * at a time.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;

  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export async function createSessionToken(username: string): Promise<{ token: string; maxAge: number }> {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = { sub: username, iat: now, exp: now + SESSION_TTL_SECONDS };
  const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  return { token: `${payloadB64}.${await sign(payloadB64)}`, maxAge: SESSION_TTL_SECONDS };
}

/** Returns the payload only if the signature verifies AND the session has not expired. */
export async function verifySessionToken(token: string | undefined): Promise<SessionPayload | null> {
  if (!token) return null;

  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const payloadB64 = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);

  let expectedSig: string;
  try {
    expectedSig = await sign(payloadB64);
  } catch {
    return null;
  }

  if (!constantTimeEqual(providedSig, expectedSig)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64)));
  } catch {
    return null;
  }

  if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
  if (Math.floor(Date.now() / 1000) >= payload.exp) return null;

  return payload;
}

export function newCsrfToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export const cookieNames = { session: SESSION_COOKIE, csrf: CSRF_COOKIE };

/**
 * `secure` is conditional purely so the dev server over plain http works.
 * `httpOnly` is not conditional: the session cookie must be unreadable from
 * JavaScript, so that an XSS bug cannot escalate into stolen credentials.
 * `sameSite: lax` blocks the cross-site POST that CSRF depends on.
 */
export function sessionCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

/** The CSRF cookie is deliberately readable by JS — the client must echo it back in a header. */
export function csrfCookieOptions(maxAge: number) {
  return {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

/** Server-component helper: the signed-in user, or null. */
export async function currentUser(): Promise<string | null> {
  const store = await cookies();
  const session = await verifySessionToken(store.get(SESSION_COOKIE)?.value);
  return session?.sub ?? null;
}
