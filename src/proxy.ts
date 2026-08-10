/**
 * Route protection.
 *
 * Next 16 renamed the `middleware` convention to `proxy`; the behaviour is
 * unchanged. The file must sit beside `app/`, and the function may be either
 * a default export or a named `proxy` export.
 *
 * Runs before every matched request, so this is the first line of defence and
 * the one place to audit for "is this screen protected". Deliberately
 * fail-closed: anything not explicitly listed as public requires a valid
 * session, so adding a route protects it by default.
 *
 * Deliberately NOT the only line of defence. Next's own guidance is that a
 * proxy check is *optimistic* — it reads the cookie and nothing else, because
 * it runs on every request including prefetches and cannot afford a database
 * round trip. Anything genuinely sensitive re-checks the session itself; see
 * `requireSession` in `src/lib/auth/guard.ts` and its use in the Tally route.
 */

import { NextResponse, type NextRequest } from "next/server";
import { cookieNames, verifySessionToken } from "@/lib/auth/session";

/**
 * Public paths.
 *
 * `/demo` is intentionally open: it is the public sales artefact, renders only
 * generated fixture data, and never touches a real company's ledger or
 * localStorage history. Login must be reachable, and the auth endpoints must
 * be callable while logged out.
 */
const PUBLIC_PATHS = ["/login", "/demo", "/api/auth/login", "/api/auth/logout"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublic(pathname)) {
    // A logged-in user landing on /login goes straight to the app rather than
    // being asked to sign in again.
    if (pathname === "/login") {
      const session = await verifySessionToken(request.cookies.get(cookieNames.session)?.value);
      if (session) return NextResponse.redirect(new URL("/", request.url));
    }
    return NextResponse.next();
  }

  const session = await verifySessionToken(request.cookies.get(cookieNames.session)?.value);

  if (!session) {
    // An API caller gets JSON; a browser gets redirected. Returning an HTML
    // login page to a fetch() would surface as an unreadable parse error.
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
    }

    const url = new URL("/login", request.url);
    // Preserve where they were headed, but only as a relative path — echoing
    // back a caller-supplied absolute URL is an open-redirect.
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  /**
   * Everything except Next's own static output and the favicon. Static assets
   * carry no ledger data, and running the proxy on each one would add latency
   * to every page for no security benefit.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
