/**
 * Login.
 *
 * Everything that decides the outcome runs here, on the server. The browser
 * never receives the hash, never compares anything, and never holds a value
 * it could tamper with to grant itself access — it gets an httpOnly cookie or
 * it gets a 401.
 */

import { NextResponse } from "next/server";
import { verifyPassword } from "@/lib/auth/password";
import {
  cookieNames,
  createSessionToken,
  csrfCookieOptions,
  newCsrfToken,
  sessionCookieOptions,
} from "@/lib/auth/session";
import { LOGIN_RULE, checkRateLimit, clientKey, resetRateLimit } from "@/lib/auth/rate-limit";

export const dynamic = "force-dynamic";

/** Deliberately identical for every failure mode — see the comment at the call sites. */
const GENERIC_FAILURE = "Username or password is incorrect.";

export async function POST(request: Request) {
  const key = clientKey(request, "login");
  const limit = checkRateLimit(key, LOGIN_RULE);

  if (!limit.allowed) {
    return NextResponse.json(
      {
        ok: false,
        error: `Too many attempts. Try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minute(s).`,
      },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  // Origin check. A cross-site form POST cannot set this header to our own
  // origin, so this blocks login-CSRF (an attacker silently signing a victim
  // into an account the attacker controls) before any work is done.
  const origin = request.headers.get("origin");
  if (origin) {
    const host = request.headers.get("host");
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
    }
    if (host && originHost !== host) {
      return NextResponse.json({ ok: false, error: "Bad request." }, { status: 403 });
    }
  }

  let body: { username?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }

  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  // Bound the input before hashing. scrypt on a megabyte-long "password" is a
  // free CPU-exhaustion primitive otherwise.
  if (!username || !password || username.length > 256 || password.length > 1024) {
    return NextResponse.json({ ok: false, error: GENERIC_FAILURE }, { status: 401 });
  }

  const expectedUser = process.env.AUTH_USERNAME;
  const expectedHash = process.env.AUTH_PASSWORD_HASH;

  if (!expectedUser || !expectedHash) {
    console.error("[auth] AUTH_USERNAME or AUTH_PASSWORD_HASH is not configured");
    return NextResponse.json(
      { ok: false, error: "Authentication is not configured on this server." },
      { status: 500 },
    );
  }

  // The password is verified even when the username is wrong, and the same
  // message is returned either way. Skipping the hash on an unknown username
  // would make the response measurably faster and turn this endpoint into a
  // username enumeration oracle.
  const passwordOk = await verifyPassword(password, expectedHash);
  const userOk = username === expectedUser;

  if (!userOk || !passwordOk) {
    return NextResponse.json({ ok: false, error: GENERIC_FAILURE }, { status: 401 });
  }

  resetRateLimit(key);

  const { token, maxAge } = await createSessionToken(username);
  const csrf = newCsrfToken();

  const response = NextResponse.json({ ok: true });
  response.cookies.set(cookieNames.session, token, sessionCookieOptions(maxAge));
  response.cookies.set(cookieNames.csrf, csrf, csrfCookieOptions(maxAge));
  return response;
}
