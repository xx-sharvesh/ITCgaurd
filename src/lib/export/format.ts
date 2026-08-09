/**
 * Small shared helpers for the export layer.
 *
 * Deliberately free of any SheetJS import so `report-model.ts` (which the UI
 * imports) never drags the spreadsheet writer into a client bundle.
 */

import type { ISODate, Paise } from "@/lib/domain/types";

// ---------------------------------------------------------------------------
// Excel number formats
// ---------------------------------------------------------------------------

/**
 * Indian currency format for Excel cells.
 *
 * READ THE COMMA PATTERN CAREFULLY: `#,##,##0.00` is NOT a typo for the
 * western `#,##0.00`. India groups the last three digits and then every TWO
 * digits above that — 12345678.9 renders as 1,23,45,678.90 (one crore twenty
 * three lakh...), not 12,345,678.90. Excel infers the repeating group from the
 * LEFTMOST comma pair, which is why the pattern needs two commas to establish
 * the 2-digit repeat and a third group of 3 at the end.
 *
 * The rupee sign is quoted so Excel treats it as a literal prefix rather than
 * trying to resolve it against the workbook's locale currency. That matters:
 * an unquoted currency symbol renders as the *reader's* local currency, and a
 * CA in Pune opening a file on a US-locale laptop would see dollars against
 * Indian numbers.
 */
export const INR_FORMAT = '"₹"#,##,##0.00';

/** Whole-rupee variant, for counts of money where paise are noise. */
export const INR_WHOLE_FORMAT = '"₹"#,##,##0';

/** Plain integer with Indian grouping. Line counts, invoice counts. */
export const INT_FORMAT = "#,##,##0";

/** Percentages stored as 0..1 fractions, shown to one decimal. */
export const PCT_FORMAT = "0.0%";

/**
 * Date format. `dd-mmm-yyyy` ("15-Jul-2026") is unambiguous — the alternative
 * numeric forms read as either day-first or month-first depending on who opens
 * the file, and a misread invoice date silently moves the Sec 16(4) deadline
 * by up to eleven months.
 */
export const DATE_FORMAT = "dd-mmm-yyyy";

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const ISO_DATE_HEAD = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * Calendar date portion of an ISO timestamp, taken verbatim.
 *
 * We do NOT convert to any timezone. The caller's offset already decided which
 * calendar day this is; re-interpreting it here would make the same run stamp
 * different dates on the server and in the browser.
 */
export function isoDateOf(isoTimestamp: string): ISODate {
  const m = ISO_DATE_HEAD.exec(isoTimestamp ?? "");
  return m ? m[0] : "";
}

/**
 * Build the Date instance SheetJS needs for a real Excel date cell.
 *
 * SheetJS 0.20.x converts `t:"d"` cells with
 * `(date.getTime() - Date.UTC(1899,11,30)) / 86400000`, i.e. straight off the
 * UTC epoch with no local-offset correction. So the Date must be UTC midnight
 * of the calendar day, or the serial lands on the wrong day for any machine
 * east or west of Greenwich. `new Date("2026-07-15")` happens to be UTC
 * midnight, but `new Date(2026, 6, 15)` is not — hence the explicit Date.UTC.
 */
export function excelDate(iso: ISODate): Date | null {
  const m = ISO_DATE_HEAD.exec(iso ?? "");
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// Ratios
// ---------------------------------------------------------------------------

/**
 * Divide two paise amounts into a 0..1 ratio, returning 0 rather than NaN or
 * Infinity when the denominator is zero. A NaN reaching a spreadsheet cell
 * becomes `#NUM!` and a CA reasonably reads that as "the tool is broken".
 */
export function safeRatio(numerator: Paise, denominator: Paise): number {
  if (!denominator) return 0;
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : 0;
}

/** Sum integer paise. Integer addition, so exact — no rounding introduced. */
export function sumPaise(values: readonly Paise[]): Paise {
  let total = 0;
  for (const v of values) total += v;
  return total;
}
