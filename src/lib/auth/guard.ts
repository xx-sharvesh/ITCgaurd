/**
 * Route-level session guard.
 *
 * The second layer behind `src/proxy.ts`. Next's own guidance is explicit
 * that a proxy check is *optimistic*: it runs on every request including
 * prefetches, so it reads the cookie and nothing more, and it should not be
 * the only thing standing between an anonymous request and a sensitive
 * action.
 *
 * That guidance matters more than usual here because the Tally route opens
 * outbound network connections on the caller's behalf. If a future refactor
 * changes the proxy matcher — say, to exclude `/api` for performance — that
 * endpoint would silently become anonymous. This makes the route refuse on
 * its own, so the protection cannot be lost by editing a different file.
 */

import "server-only";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { cookieNames, verifySessionToken, type SessionPayload } from "./session";

export type GuardResult = { ok: true; session: SessionPayload } | { ok: false; response: NextResponse };

/**
 * Require a valid session, or produce the 401 to return.
 *
 * Returns rather than throws so the caller keeps control of the response
 * shape — the Tally route has its own typed error envelope, and a thrown
 * error would be flattened into a generic one.
 */
export async function requireSession(): Promise<GuardResult> {
  const store = await cookies();
  const session = await verifySessionToken(store.get(cookieNames.session)?.value);

  if (!session) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: { kind: "UNAUTHENTICATED", message: "Not authenticated.", hint: "Sign in and try again." } },
        { status: 401 },
      ),
    };
  }

  return { ok: true, session };
}
