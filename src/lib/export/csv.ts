/**
 * RFC4180 CSV serialisation for ad-hoc exports.
 *
 * The .xlsx working paper is the primary artefact; CSV exists because half the
 * CAs in this market pipe everything into their own audit macros and want a
 * dumb, greppable file with no formatting in the way.
 */

import { assertBrowser, downloadBlob } from "./download";

/**
 * UTF-8 byte order mark.
 *
 * Excel on Windows does NOT sniff UTF-8. Without a BOM it decodes a .csv using
 * the legacy ANSI code page, so "₹1,23,456" arrives as "â‚¹1,23,456" and every
 * vendor name with a Devanagari or accented character turns to mojibake. Three
 * bytes at the front of the file is the entire fix, and it is invisible to
 * every other tool that reads UTF-8 properly.
 *
 * Spelled as an escape, not the literal character: a bare U+FEFF is invisible
 * in every editor and gets silently eaten by formatters and copy-paste.
 */
export const UTF8_BOM = "\uFEFF";

/** RFC4180 mandates CRLF between records. */
const CRLF = "\r\n";

/**
 * Fields needing quotes: comma (separator), double quote (the escape char
 * itself), CR or LF (record separator). Leading/trailing spaces are also
 * quoted — they are legal unquoted, but several parsers silently trim them and
 * an invoice number of " 91" must survive the round trip.
 */
const NEEDS_QUOTING = /[",\r\n]|^\s|\s$/;

/**
 * Serialise rows to CSV with a header line taken from the union of all keys,
 * in first-appearance order.
 *
 * Heterogeneous rows are tolerated (a missing key emits an empty field) because
 * callers legitimately export filtered views where later rows carry extra
 * columns.
 */
export function toCsv(rows: Record<string, unknown>[]): string {
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }

  if (headers.length === 0) return UTF8_BOM;

  const lines: string[] = [headers.map(escapeField).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeField(stringify(row[h]))).join(","));
  }

  return UTF8_BOM + lines.join(CRLF) + CRLF;
}

/**
 * Quote a field if it needs it, doubling any embedded quote.
 *
 * Note we deliberately do not neutralise leading `=`/`+`/`@` (spreadsheet
 * formula injection). Mutating a value would break the CA's tie-back to the
 * source register, and these files are generated from the user's own uploads
 * rather than third-party input.
 */
function escapeField(value: string): string {
  if (!NEEDS_QUOTING.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";

  if (typeof value === "string") return value;

  if (typeof value === "number") {
    // NaN/Infinity would serialise as literal "NaN", which reads as data.
    return Number.isFinite(value) ? String(value) : "";
  }

  // Excel recognises bare TRUE/FALSE as booleans; "true" it treats as text.
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";

  if (typeof value === "bigint") return value.toString();

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    const iso = value.toISOString();
    // Date-only values are far more readable without the 00:00:00.000Z tail.
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
  }

  if (typeof value === "object") {
    try {
      return JSON.stringify(value) ?? "";
    } catch {
      return "";
    }
  }

  return String(value);
}

/**
 * Browser helper: save a CSV string as a file.
 *
 * Takes the already-serialised string rather than rows so callers can post-
 * process (append a totals line, strip a column) before saving.
 */
export function downloadCsv(filename: string, csv: string): void {
  // Guard before touching Blob — it, too, is undefined on the server, and the
  // resulting ReferenceError would be far less diagnosable than our message.
  assertBrowser("downloadCsv");

  // charset=utf-8 plus the BOM inside the payload — belt and braces, because
  // the charset parameter is ignored once the file hits the local filesystem.
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  downloadBlob(blob, filename.toLowerCase().endsWith(".csv") ? filename : `${filename}.csv`);
}
