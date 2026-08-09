/**
 * Canonicalisation of the two fields that break naive reconciliation:
 * invoice numbers and dates.
 *
 * The supplier types the invoice number into their GSTR-1; the buyer's clerk
 * types it into the purchase register. They almost never agree character for
 * character. "INV/2026-27/0091" and "inv-2026-27-91" are the same document,
 * and a tool that reports that as a mismatch has just created work instead of
 * removing it.
 *
 * The counter-risk is over-normalising until two genuinely different documents
 * collide. So we emit a ladder of keys of decreasing strictness, and the
 * matcher is required to demand more corroborating evidence (amount, date,
 * GSTIN) the looser the key it matched on.
 */

import type { ISODate } from "./types";

// ---------------------------------------------------------------------------
// Invoice numbers
// ---------------------------------------------------------------------------

export interface InvoiceKeys {
  /** Uppercased, punctuation and spaces removed. "INV/26-27/0091" → "INV26270091" */
  strict: string;
  /** strict, with leading zeros inside each digit run collapsed. → "INV262791" */
  loose: string;
  /** Trailing digit run with leading zeros stripped. → "91" */
  numericTail: string;
  /** Leading alphabetic prefix. → "INV" */
  alphaPrefix: string;
}

/**
 * Financial-year fragments that suppliers embed in invoice numbers and buyers
 * frequently drop or reformat. Removing them from the loose key lets
 * "INV/2026-27/91" reach "INV/91", but only the loose tier sees this.
 */
const FY_FRAGMENT = /(20\d{2})[-/]?(\d{2})(?![0-9])/g;

/**
 * Split an invoice number into meaningful segments.
 *
 * Segmentation happens at punctuation AND at every alpha/digit transition,
 * which is the crux of the whole thing. Simply deleting separators merges
 * adjacent digit runs — "INV/2026-27/0091" would collapse to "…2026270091" —
 * and once merged, leading zeros can no longer be identified or stripped, so
 * the same document recorded two ways never canonicalises together.
 *
 * Keeping the segments apart lets us strip zeros per segment and rejoin:
 *   "INV/2026-27/0091" → [INV, 2026, 27, 0091] → [INV, 2026, 27, 91]
 *   "inv-2026-27-91"   → [INV, 2026, 27, 91]   → same
 * while "INV/91" and "INV/191" stay firmly apart.
 */
function invoiceSegments(raw: string): string[] {
  const upper = (raw ?? "").toUpperCase().trim();
  const out: string[] = [];
  for (const token of upper.split(/[^A-Z0-9]+/)) {
    if (!token) continue;
    // Split runs of letters from runs of digits: "INV0091" → INV, 0091.
    const parts = token.match(/\d+|[A-Z]+/g);
    if (parts) out.push(...parts);
  }
  return out;
}

export function invoiceKeys(raw: string): InvoiceKeys {
  const segments = invoiceSegments(raw);

  const strict = segments.join("");

  // Strip leading zeros per numeric segment, now that segments are intact.
  const loose = segments
    .map((s) => (/^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, "") : s))
    .join("");

  const numericSegments = segments.filter((s) => /^\d+$/.test(s));
  const lastNumeric = numericSegments[numericSegments.length - 1];
  const numericTail = lastNumeric ? lastNumeric.replace(/^0+(?=\d)/, "") : "";

  const alphaPrefix = segments.length > 0 && /^[A-Z]+$/.test(segments[0]) ? segments[0] : "";

  return { strict, loose, numericTail, alphaPrefix };
}

/**
 * Loose key with any embedded financial year removed. Used only as a
 * last-resort tier, and never without an amount match.
 */
export function invoiceKeyWithoutFY(raw: string): string {
  const stripped = (raw ?? "").toUpperCase().replace(FY_FRAGMENT, " ");
  return invoiceKeys(stripped).loose;
}

/**
 * Levenshtein distance, capped for early exit.
 *
 * Used to catch single-character transcription slips ("INV9I" for "INV91").
 * Capped because we only ever care about distances of 1 or 2 — anything
 * further apart is a different document, and computing the true distance on
 * long strings across a 10,000-line register is wasted work.
 */
export function boundedLevenshtein(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }

  return prev[b.length];
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12,
};

/**
 * Parse the date formats that appear in Indian purchase registers and 2B files.
 *
 * Ambiguity policy: bare numeric dates are read as DAY-FIRST. Indian
 * accounting output is overwhelmingly DD-MM-YYYY, and the GST portal itself
 * emits DD-MM-YYYY. Reading "05-04-2026" as 5 April (not 4 May) is therefore
 * the correct default, and guessing per-value would make results
 * non-deterministic across files.
 *
 * Returns null rather than a wrong date — a silently wrong invoice date
 * corrupts the 180-day and Sec 16(4) clocks.
 */
export function parseGstDate(input: unknown): ISODate | null {
  if (input === null || input === undefined || input === "") return null;

  // SheetJS hands back Date objects when cellDates is enabled.
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) return null;
    return toISO(input.getUTCFullYear(), input.getUTCMonth() + 1, input.getUTCDate());
  }

  // Excel serial date (days since 1899-12-30 in the 1900 system).
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input <= 0 || input > 2_958_465) return null;
    const ms = Math.round(input * 86_400_000);
    const d = new Date(Date.UTC(1899, 11, 30) + ms);
    return toISO(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }

  if (typeof input !== "string") return null;
  const s = input.trim();
  if (!s) return null;

  // ISO first — unambiguous.
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (m) return validated(+m[1], +m[2], +m[3]);

  // DD-MMM-YYYY / DD MMM YY  e.g. "05-Apr-2026", "5 April 26"
  m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3,9})[-/ ](\d{2}|\d{4})$/);
  if (m) {
    const mon = MONTHS[m[2].toUpperCase().slice(0, m[2].length >= 4 && m[2].toUpperCase().startsWith("SEPT") ? 4 : 3)];
    if (!mon) return null;
    return validated(expandYear(+m[3]), mon, +m[1]);
  }

  // DD-MM-YYYY / DD/MM/YY — day first, per the policy above.
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/);
  if (m) return validated(expandYear(+m[3]), +m[2], +m[1]);

  return null;
}

function expandYear(y: number): number {
  if (y >= 1000) return y;
  // Two-digit years: 00-79 → 2000s, 80-99 → 1900s. GST began in 2017, so a
  // two-digit year in this data is always current-century in practice.
  return y < 80 ? 2000 + y : 1900 + y;
}

function validated(year: number, month: number, day: number): ISODate | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (year < 2017 || year > 2100) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  // Rejects 31 Feb and friends, which round forward silently otherwise.
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return toISO(year, month, day);
}

function toISO(y: number, m: number, d: number): ISODate {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Whole days from a to b. Negative when b precedes a. */
export function daysBetween(a: ISODate, b: ISODate): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

export function addDays(date: ISODate, days: number): ISODate {
  const d = new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000);
  return toISO(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * Indian financial year for a date: 1 April to 31 March.
 * A 15 March 2027 invoice belongs to FY 2026-27, not 2027-28.
 */
export function financialYearOf(date: ISODate): string {
  const [y, m] = date.split("-").map(Number);
  const startYear = m >= 4 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

/**
 * Sec 16(4) deadline: credit for an invoice must be claimed by 30 November
 * following the end of the financial year to which it relates.
 */
export function sec16_4Deadline(invoiceDate: ISODate): ISODate {
  const [y, m] = invoiceDate.split("-").map(Number);
  const fyStart = m >= 4 ? y : y - 1;
  return `${fyStart + 1}-11-30`;
}

/** GST return period `MMYYYY` for a date. */
export function periodOf(date: ISODate): string {
  const [y, m] = date.split("-").map(Number);
  return `${String(m).padStart(2, "0")}${y}`;
}

export function formatPeriod(period: string): string {
  const m = Number(period.slice(0, 2));
  const y = period.slice(2);
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[m - 1] ?? "?"} ${y}`;
}

/** Display form for dates in the UI: "05 Apr 2026". */
export function formatDate(date: ISODate): string {
  const [y, m, d] = date.split("-").map(Number);
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(d).padStart(2, "0")} ${names[m - 1] ?? "?"} ${y}`;
}

// ---------------------------------------------------------------------------
// Vendor names
// ---------------------------------------------------------------------------

const LEGAL_SUFFIXES = [
  "PRIVATE LIMITED", "PVT LTD", "PVT. LTD.", "P LTD", "LIMITED", "LTD",
  "LLP", "AND SONS", "& SONS", "AND CO", "& CO", "ENTERPRISES", "ENTERPRISE",
  "INDUSTRIES", "TRADERS", "TRADING", "CORPORATION", "CORP", "INC",
];

/**
 * Reduce a vendor name to a comparison key. Used only to group and to warn
 * about likely duplicate vendor masters — never to match invoices, since two
 * unrelated firms can share a trading name across states.
 */
export function vendorNameKey(name: string): string {
  // Collapse whitespace before matching suffixes: "PVT. LTD." becomes
  // "PVT  LTD" once punctuation is spaced out, and a two-space gap would stop
  // the single-spaced "PVT LTD" pattern from ever matching.
  let s = (name ?? "").toUpperCase().replace(/[.,'"()]/g, " ").replace(/\s+/g, " ").trim();
  for (const suffix of LEGAL_SUFFIXES) {
    s = s.replace(new RegExp(`\\b${suffix.replace(/[.&]/g, "\\$&")}\\b`, "g"), " ");
    s = s.replace(/\s+/g, " ").trim();
  }
  return s;
}
