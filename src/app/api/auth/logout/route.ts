/**
 * Logout.
 *
 * Sessions are stateless, so "logging out" means expiring the cookie in the
 * browser. Be honest about the limit: a token already copied off the machine
 * stays valid until its own expiry. The lever that revokes everything
 * everywhere is rotating AUTH_SECRET — see docs/SECURITY.md.
 */

import { NextResponse } from "next/server";
import { cookieNames, csrfCookieOptions, sessionCookieOptions } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(cookieNames.session, "", sessionCookieOptions(0));
  response.cookies.set(cookieNames.csrf, "", csrfCookieOptions(0));
  return response;
}
