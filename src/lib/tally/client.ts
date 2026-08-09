/**
 * Tally HTTP client. Server-side only.
 *
 * The browser cannot talk to Tally directly: the gateway sends no CORS
 * headers, so every fetch from a page is blocked before it leaves. Everything
 * here therefore runs in the Next.js server process, which must be on the same
 * machine as Tally or on the same LAN.
 *
 * Two hard limits, both learned from how Tally actually behaves:
 *   - A generous timeout. Tally is single-threaded per company and a wide date
 *     range on a large company genuinely takes tens of seconds. It also stops
 *     answering entirely while a modal dialog is open on the operator's screen.
 *   - A byte cap. A year of vouchers can be hundreds of megabytes of XML, and
 *     buffering that into a string will take the server down.
 */

import "server-only";

import { TallyError } from "./errors";
import { assertAllowedTallyUrl } from "./url-guard";
import {
  DEFAULT_TALLY_URL,
  ledgerMastersRequest,
  listCompaniesRequest,
  purchaseRegisterRequest,
} from "./requests";
import {
  applyLedgerGstins,
  parseCompanies,
  parseLedgers,
  parsePurchaseVouchers,
  type TallyCompany,
  type TallyParseResult,
} from "./parse";

/** Tally can stall for a long while on a big export; 90s before we give up. */
const TIMEOUT_MS = 90_000;

/** 50 MB. Beyond this the caller must narrow the date range. */
const MAX_BYTES = 50 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function post(rawUrl: string, body: string): Promise<string> {
  const url = assertAllowedTallyUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      // Tally is indifferent to content-type but rejects chunked bodies from
      // some clients; a plain string keeps it simple and well-formed.
      headers: { "Content-Type": "text/xml; charset=utf-8" },
      body,
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new TallyError("TIMEOUT", `Tally did not respond within ${TIMEOUT_MS / 1000} seconds.`, { cause: err });
    }
    const diagnosis = diagnose(err);
    throw new TallyError(
      diagnosis.kind,
      diagnosis.kind === "CONNECTION_REFUSED"
        ? `Nothing is listening at ${url.origin}.`
        : `Could not reach ${url.origin}.`,
      { detail: diagnosis.detail, cause: err },
    );
  }

  try {
    if (!response.ok) {
      throw new TallyError("HTTP_ERROR", `Tally returned HTTP ${response.status}.`, {
        httpStatus: response.status,
      });
    }
    return await readCapped(response);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Work out what actually went wrong with a failed fetch.
 *
 * Node's fetch reports every transport failure as the useless message
 * "fetch failed" and hides the real reason in `error.cause`, sometimes nested
 * more than one level down. Distinguishing a refused connection matters: that
 * is the overwhelmingly common case (Tally open but the HTTP gateway not
 * switched on) and it is the only one whose hint tells the operator exactly
 * which Tally menu to visit. Reporting it as a generic network error sends
 * them to inspect a firewall that was never the problem.
 */
function diagnose(err: unknown): { kind: "CONNECTION_REFUSED" | "NETWORK_ERROR"; detail: string } {
  const seen = new Set<unknown>();
  const parts: string[] = [];

  let current: unknown = err;
  while (current && !seen.has(current)) {
    seen.add(current);

    if (typeof current === "object") {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string") parts.push(code);
      const message = (current as { message?: unknown }).message;
      if (typeof message === "string") parts.push(message);
      // AggregateError, which undici uses when several addresses are tried
      // (a host resolving to both IPv6 and IPv4 is the usual cause).
      const errors = (current as { errors?: unknown }).errors;
      if (Array.isArray(errors)) {
        for (const e of errors) {
          const c = (e as { code?: unknown })?.code;
          if (typeof c === "string") parts.push(c);
        }
      }
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }

  // Walking the cause chain collects the same code several times over; the
  // operator only needs to read it once.
  const unique = [...new Set(parts.map((p) => p.trim()).filter(Boolean))];
  const joined = unique.join(" | ");

  return {
    kind: /ECONNREFUSED|refused/i.test(joined) ? "CONNECTION_REFUSED" : "NETWORK_ERROR",
    detail: joined || "Unknown transport failure",
  };
}

/**
 * Read the body while enforcing the byte cap as we go.
 *
 * Checking Content-Length is not enough — Tally usually omits it. Streaming
 * and counting means we abort a runaway export instead of discovering the
 * problem after it has already been buffered into memory.
 */
async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return response.text();

  const decoder = new TextDecoder("utf-8");
  const parts: string[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new TallyError(
        "RESPONSE_TOO_LARGE",
        `The export exceeded the ${MAX_BYTES / 1024 / 1024} MB safety cap.`,
      );
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());

  const text = parts.join("");
  if (!text.trim()) {
    throw new TallyError("EMPTY_RESULT", "Tally answered with an empty body.");
  }
  return text;
}

/**
 * Tally reports its own failures inside a 200 response. `<LINEERROR>` carries
 * the message; the most common one by far is that the requested company is not
 * open in Tally, which reads to a user as "it just returned nothing".
 */
function assertNoTallyError(xml: string): void {
  const lineError = xml.match(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/i);
  if (lineError) {
    throw new TallyError("TALLY_ERROR", collapseWhitespace(lineError[1]) || "Tally reported an error.");
  }
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface ProbeResult {
  reachable: true;
  url: string;
  companies: TallyCompany[];
}

export async function probeTally(url: string = DEFAULT_TALLY_URL): Promise<ProbeResult> {
  const xml = await post(url, listCompaniesRequest());
  assertNoTallyError(xml);
  return { reachable: true, url, companies: parseCompanies(xml) };
}

export async function fetchCompanies(url: string = DEFAULT_TALLY_URL): Promise<TallyCompany[]> {
  const xml = await post(url, listCompaniesRequest());
  assertNoTallyError(xml);
  return parseCompanies(xml);
}

export interface FetchRegisterOptions {
  url?: string;
  company: string;
  fromDate: string;
  toDate: string;
  /**
   * Also pull the ledger masters and use them to fill in GSTINs missing from
   * the vouchers. Worth the extra round trip: many companies record the GSTIN
   * only once, on the ledger.
   */
  enrichWithLedgers?: boolean;
}

export interface FetchRegisterResult extends TallyParseResult {
  company: string;
  fromDate: string;
  toDate: string;
  /** How many GSTINs were recovered from the ledger masters. */
  gstinsFilledFromLedgers: number;
}

export async function fetchPurchaseRegister(
  options: FetchRegisterOptions,
): Promise<FetchRegisterResult> {
  const url = options.url ?? DEFAULT_TALLY_URL;

  const xml = await post(
    url,
    purchaseRegisterRequest({
      company: options.company,
      fromDate: options.fromDate,
      toDate: options.toDate,
    }),
  );
  assertNoTallyError(xml);

  const parsed = parsePurchaseVouchers(xml);

  if (parsed.records.length === 0 && parsed.vouchersSeen === 0) {
    throw new TallyError(
      "EMPTY_RESULT",
      `No vouchers came back for "${options.company}" between ${options.fromDate} and ${options.toDate}.`,
      { detail: "The most common cause is that the company is not open in Tally." },
    );
  }

  let records = parsed.records;
  let gstinsFilledFromLedgers = 0;

  if (options.enrichWithLedgers !== false && records.some((r) => !r.supplierGstin)) {
    try {
      const ledgerXml = await post(url, ledgerMastersRequest({ company: options.company }));
      const applied = applyLedgerGstins(records, parseLedgers(ledgerXml));
      records = applied.records;
      gstinsFilledFromLedgers = applied.filled;
    } catch {
      // Enrichment is a bonus, not a requirement. If the ledger export fails
      // we still return the vouchers — the affected lines simply stay
      // unmatched, and their warnings already say so.
    }
  }

  return {
    ...parsed,
    records,
    company: options.company,
    fromDate: options.fromDate,
    toDate: options.toDate,
    gstinsFilledFromLedgers,
  };
}
