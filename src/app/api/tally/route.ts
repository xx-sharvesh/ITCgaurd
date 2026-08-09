/**
 * Tally proxy.
 *
 * Exists because Tally's HTTP gateway sends no CORS headers, so the browser
 * cannot call it. This route runs in the Next.js server process, which must be
 * on the same machine as Tally or on the same LAN.
 *
 * Security posture: this endpoint performs a server-side fetch to a
 * client-supplied address, which is exactly the shape of an SSRF. The address
 * is validated against a loopback/RFC1918 allowlist in `assertAllowedTallyUrl`
 * before any socket is opened, literal IPs only, plain http only. Errors are
 * returned as a typed kind plus an operator hint — never a stack trace.
 */

import { NextResponse } from "next/server";
import { TallyError, TALLY_ERROR_STATUS, isTallyError } from "@/lib/tally/errors";
import { DEFAULT_TALLY_URL } from "@/lib/tally/requests";
import { fetchCompanies, fetchPurchaseRegister, probeTally } from "@/lib/tally/client";
import { TALLY_RULE, checkRateLimit, clientKey } from "@/lib/auth/rate-limit";

/** Talks to a machine-local service; there is nothing here worth caching. */
export const dynamic = "force-dynamic";

/**
 * Reject a cross-origin POST outright.
 *
 * Authentication alone is not enough here: a logged-in user visiting a hostile
 * page could have their browser fire this endpoint, and the SSRF allowlist
 * would still happily scan their internal network on the attacker's behalf.
 * `sameSite: lax` on the session cookie already blocks the credential from
 * riding along, and this is the explicit second layer.
 */
function crossOriginRejected(request: Request): NextResponse | null {
  const origin = request.headers.get("origin");
  if (!origin) return null; // Same-origin fetches and server-side calls omit it.

  const host = request.headers.get("host");
  try {
    if (host && new URL(origin).host !== host) {
      return NextResponse.json({ ok: false, error: { kind: "BAD_REQUEST", message: "Cross-origin request refused.", hint: "" } }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ ok: false, error: { kind: "BAD_REQUEST", message: "Malformed origin.", hint: "" } }, { status: 400 });
  }
  return null;
}

interface RequestBody {
  action?: unknown;
  url?: unknown;
  company?: unknown;
  fromDate?: unknown;
  toDate?: unknown;
}

const ACTIONS = new Set(["probe", "companies", "purchases"]);

export async function POST(request: Request) {
  const rejected = crossOriginRejected(request);
  if (rejected) return rejected;

  const limit = checkRateLimit(clientKey(request, "tally"), TALLY_RULE);
  if (!limit.allowed) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          kind: "RATE_LIMITED",
          message: "Too many Tally requests.",
          hint: `Wait ${limit.retryAfterSeconds} second(s) and try again.`,
        },
      },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return fail(new TallyError("BAD_REQUEST", "Request body must be JSON."));
  }

  const action = typeof body.action === "string" ? body.action : "";
  if (!ACTIONS.has(action)) {
    return fail(
      new TallyError("BAD_REQUEST", `Unknown action "${action}". Expected probe, companies or purchases.`),
    );
  }

  const url = typeof body.url === "string" && body.url.trim() ? body.url.trim() : DEFAULT_TALLY_URL;

  try {
    switch (action) {
      case "probe":
        return NextResponse.json({ ok: true, ...(await probeTally(url)) });

      case "companies":
        return NextResponse.json({ ok: true, companies: await fetchCompanies(url) });

      case "purchases": {
        const company = requireString(body.company, "company");
        const fromDate = requireString(body.fromDate, "fromDate");
        const toDate = requireString(body.toDate, "toDate");

        if (fromDate > toDate) {
          throw new TallyError("BAD_REQUEST", "fromDate is after toDate.");
        }

        const result = await fetchPurchaseRegister({ url, company, fromDate, toDate });

        return NextResponse.json({
          ok: true,
          company: result.company,
          fromDate: result.fromDate,
          toDate: result.toDate,
          vouchersSeen: result.vouchersSeen,
          truncated: result.truncated,
          records: result.records,
          warnings: result.warnings,
          repairs: result.repairs,
          gstinsFilledFromLedgers: result.gstinsFilledFromLedgers,
          bankDirectory: result.bankDirectory,
        });
      }

      default:
        return fail(new TallyError("BAD_REQUEST", "Unsupported action."));
    }
  } catch (err) {
    if (isTallyError(err)) return fail(err);

    // Anything unexpected is logged server-side and reported generically. The
    // client never sees an internal message.
    console.error("[tally] unexpected failure", err);
    return fail(new TallyError("NETWORK_ERROR", "The Tally request failed unexpectedly."));
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TallyError("BAD_REQUEST", `"${field}" is required.`);
  }
  return value.trim();
}

function fail(error: TallyError) {
  return NextResponse.json({ ok: false, error: error.toJSON() }, { status: TALLY_ERROR_STATUS[error.kind] });
}
