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

/** Talks to a machine-local service; there is nothing here worth caching. */
export const dynamic = "force-dynamic";

interface RequestBody {
  action?: unknown;
  url?: unknown;
  company?: unknown;
  fromDate?: unknown;
  toDate?: unknown;
}

const ACTIONS = new Set(["probe", "companies", "purchases"]);

export async function POST(request: Request) {
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
