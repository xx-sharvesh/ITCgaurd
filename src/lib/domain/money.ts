/**
 * Integer-paise money. No floats cross this boundary.
 *
 * Why this exists: 0.1 + 0.2 !== 0.3 in IEEE-754, and a reconciliation engine
 * that drifts by a paise per line will report a fake mismatch on a ten-thousand
 * line register. Every amount is stored as an integer count of paise and only
 * rendered as rupees at the very edge.
 */

import type { Paise, TaxAmounts } from "./types";

export const ZERO_TAX: Readonly<TaxAmounts> = Object.freeze({
  igst: 0,
  cgst: 0,
  sgst: 0,
  cess: 0,
});

/**
 * Parse a rupee amount from arbitrary spreadsheet input into integer paise.
 *
 * Handles the shapes that actually turn up in Indian purchase registers:
 * "1,23,456.78", "₹1234.5", "(1234.00)" for negatives, "1234.005" (banker
 * rounding not applied — GST works to 2dp, we round half away from zero),
 * blank cells, and real JS numbers from SheetJS.
 *
 * Returns null for anything it cannot read, so callers must decide explicitly
 * rather than silently receiving a zero.
 */
export function parsePaise(input: unknown): Paise | null {
  if (input === null || input === undefined) return null;

  if (typeof input === "number") {
    if (!Number.isFinite(input)) return null;
    return rupeesToPaise(input);
  }

  if (typeof input !== "string") return null;

  let s = input.trim();
  if (s === "" || s === "-" || s === "—") return null;

  // Accounting negatives: (1,234.00)
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }

  // Strip currency symbols, INR/Rs prefixes, spaces, and thousands separators.
  s = s
    .replace(/[₹$]/g, "")
    .replace(/\bINR\b/gi, "")
    .replace(/\bRs\.?/gi, "")
    .replace(/[,\s ]/g, "")
    .trim();

  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  }
  if (s.startsWith("+")) s = s.slice(1);

  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;

  const value = Number(s);
  if (!Number.isFinite(value)) return null;

  const paise = rupeesToPaise(value);
  return negative ? -paise : paise;
}

/**
 * Convert a rupee float to integer paise, rounding half away from zero.
 *
 * The epsilon nudge defeats representations like 1234.565 arriving as
 * 1234.5649999999998, which would otherwise round down and lose a paise.
 */
export function rupeesToPaise(rupees: number): Paise {
  if (!Number.isFinite(rupees)) return 0;
  const scaled = rupees * 100;
  const sign = scaled < 0 ? -1 : 1;
  const magnitude = Math.abs(scaled);
  return sign * Math.round(magnitude + Number.EPSILON * magnitude);
}

export function paiseToRupees(paise: Paise): number {
  return paise / 100;
}

/** Sum the four tax heads. This is the recoverable credit on a line. */
export function totalTax(tax: TaxAmounts): Paise {
  return tax.igst + tax.cgst + tax.sgst + tax.cess;
}

export function addTax(a: TaxAmounts, b: TaxAmounts): TaxAmounts {
  return {
    igst: a.igst + b.igst,
    cgst: a.cgst + b.cgst,
    sgst: a.sgst + b.sgst,
    cess: a.cess + b.cess,
  };
}

export function subtractTax(a: TaxAmounts, b: TaxAmounts): TaxAmounts {
  return {
    igst: a.igst - b.igst,
    cgst: a.cgst - b.cgst,
    sgst: a.sgst - b.sgst,
    cess: a.cess - b.cess,
  };
}

export function sumTax(items: TaxAmounts[]): TaxAmounts {
  return items.reduce(addTax, { ...ZERO_TAX });
}

// ---------------------------------------------------------------------------
// Formatting — the only place rupees exist
// ---------------------------------------------------------------------------

const INR = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const INR_WHOLE = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** Full precision, e.g. "₹12,34,567.89". Use in tables and working papers. */
export function formatINR(paise: Paise): string {
  return INR.format(paiseToRupees(paise));
}

/** No paise, e.g. "₹12,34,568". Use where the decimals are noise. */
export function formatINRWhole(paise: Paise): string {
  return INR_WHOLE.format(paiseToRupees(paise));
}

/**
 * Indian short scale, e.g. "₹1.23 Cr" / "₹4.82 L" / "₹9,400".
 *
 * Crore and lakh, not million — a CFO in Pune reads "₹1.2 Cr" instantly and
 * has to stop and convert "₹12M". Used for headline figures only; never in a
 * column a CA will tie back to a ledger.
 */
export function formatINRCompact(paise: Paise): string {
  const rupees = paiseToRupees(paise);
  const abs = Math.abs(rupees);
  const sign = rupees < 0 ? "-" : "";

  if (abs >= 1_00_00_000) {
    return `${sign}₹${trimZeros(abs / 1_00_00_000)} Cr`;
  }
  if (abs >= 1_00_000) {
    return `${sign}₹${trimZeros(abs / 1_00_000)} L`;
  }
  if (abs >= 1_000) {
    return `${sign}${INR_WHOLE.format(abs)}`;
  }
  return `${sign}${INR_WHOLE.format(abs)}`;
}

function trimZeros(n: number): string {
  return n
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(/(\.\d)0$/, "$1");
}

/** Absolute paise difference. */
export function absDelta(a: Paise, b: Paise): Paise {
  return Math.abs(a - b);
}
