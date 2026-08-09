/**
 * Deterministic synthetic dataset.
 *
 * Produces a purchase register and a matching GSTR-2B for a mid-size
 * Maharashtra manufacturer, with every defect class this product claims to
 * catch deliberately seeded and labelled. The labels are the ground truth the
 * test suite asserts against — without them "the matcher looks about right" is
 * the best claim we could make, and that is not good enough for a tool that
 * tells a CFO their credit is safe.
 *
 * Determinism is a hard requirement. Same seed, same bytes, every run. A
 * reconciliation fixture that shifts under you cannot be regression-tested.
 */

import type {
  DocumentType,
  GSTR2BRecord,
  MsmeStatus,
  Paise,
  PurchaseRecord,
  TaxAmounts,
} from "../domain/types";
import { addDays, periodOf } from "../domain/normalize";
import { BUYER_STATE_CODE, corruptGstinChecksum } from "./gstins";
import { VENDORS, type NumberingStyle, type VendorFixture } from "./vendors";

// ---------------------------------------------------------------------------
// Ground truth
// ---------------------------------------------------------------------------

export type ExpectedLabel =
  | "CLEAN"
  | "FORMAT_DRIFT"
  | "ROUNDING"
  | "DATE_DRIFT"
  | "VALUE_MISMATCH"
  | "RATE_MISMATCH"
  | "BOOKS_ONLY"
  | "GSTR2B_ONLY"
  | "CREDIT_NOTE"
  | "INELIGIBLE"
  | "RULE_37A"
  | "RULE_37"
  | "MSME_OVERDUE"
  | "TIME_BARRED"
  | "BAD_GSTIN"
  | "REVERSE_CHARGE"
  | "MUST_NOT_MATCH";

export interface ExpectedOutcome {
  purchaseId?: string;
  gstr2bId?: string;
  label: ExpectedLabel;
  shouldMatch: boolean;
  note: string;
}

export interface GeneratedDataset {
  purchases: PurchaseRecord[];
  gstr2b: GSTR2BRecord[];
  expected: ExpectedOutcome[];
  /** Reference date the scenario is built around. */
  asOf: string;
  period: string;
  seed: number;
}

export interface GenerateOptions {
  seed?: number;
  /** Approximate number of purchase lines. */
  lines?: number;
  /** Reference "today". Every clock in the scenario is relative to this. */
  asOf?: string;
  /** Period under reconciliation. */
  period?: string;
}

// ---------------------------------------------------------------------------
// Deterministic PRNG
// ---------------------------------------------------------------------------

/** mulberry32 — small, fast, and identical across platforms. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Rng {
  next: () => number;
  int: (min: number, max: number) => number;
  pick: <T>(items: readonly T[]) => T;
  chance: (p: number) => boolean;
}

function makeRng(seed: number): Rng {
  const next = mulberry32(seed);
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    pick: <T>(items: readonly T[]): T => items[int(0, items.length - 1)],
    chance: (p: number) => next() < p,
  };
}

// ---------------------------------------------------------------------------
// Invoice numbering
// ---------------------------------------------------------------------------

const MONTH_ABBR = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function fyLabel(date: string): { full: string; short: string; compact: string } {
  const [y, m] = date.split("-").map(Number);
  const start = m >= 4 ? y : y - 1;
  const endShort = String((start + 1) % 100).padStart(2, "0");
  return {
    full: `${start}-${endShort}`,
    short: `${String(start % 100).padStart(2, "0")}-${endShort}`,
    compact: `${String(start % 100).padStart(2, "0")}${endShort}`,
  };
}

function formatInvoiceNumber(
  style: NumberingStyle,
  prefix: string,
  serial: number,
  date: string,
): string {
  const fy = fyLabel(date);
  const padded = String(serial).padStart(4, "0");
  const month = MONTH_ABBR[Number(date.split("-")[1]) - 1];

  switch (style) {
    case "SLASH_FY":
      return `${prefix}/${fy.full}/${padded}`;
    case "DASH_FY":
      return `${prefix}-${fy.short}-${padded}`;
    case "PREFIX_SEQ":
      return `${prefix}-${padded}`;
    case "PLAIN_SEQ":
      return padded;
    case "SLASH_MONTH":
      return `${prefix}/${month}/${padded}`;
    case "COMPACT_FY":
      return `${prefix}${fy.compact}${padded}`;
  }
}

/**
 * Re-render the same invoice number the way the *other* party typed it.
 *
 * This is the single most common cause of false mismatches in the wild: the
 * supplier's GSTR-1 and the buyer's register hold the same document under
 * cosmetically different strings. Reproducing that faithfully is what makes
 * the fixture worth testing against.
 */
function driftInvoiceNumber(original: string, rng: Rng): string {
  const variants: Array<(s: string) => string> = [
    (s) => s.replace(/\//g, "-"),
    (s) => s.replace(/-/g, "/"),
    (s) => s.replace(/(\d)0+(\d+)$/, "$1$2"),
    (s) => s.replace(/(^|[^0-9])0+(\d)/g, "$1$2"),
    (s) => s.toLowerCase(),
    (s) => s.replace(/[/-]/g, ""),
    (s) => ` ${s} `,
  ];
  return rng.pick(variants)(original);
}

// ---------------------------------------------------------------------------
// Tax construction
// ---------------------------------------------------------------------------

const GST_RATES = [5, 12, 18, 18, 18, 28] as const;

function buildTax(taxable: Paise, rate: number, interState: boolean): TaxAmounts {
  const total = Math.round((taxable * rate) / 100);
  if (interState) {
    return { igst: total, cgst: 0, sgst: 0, cess: 0 };
  }
  // Halve to CGST and SGST; give the odd paise to CGST so the two always sum
  // back to the full tax. Splitting with two independent roundings is how
  // real registers end up a paise short.
  const cgst = Math.round(total / 2);
  return { igst: 0, cgst, sgst: total - cgst, cess: 0 };
}

function taxTotal(t: TaxAmounts): Paise {
  return t.igst + t.cgst + t.sgst + t.cess;
}

/** Realistic invoice values, log-skewed: many small, a few very large. */
function drawTaxableValue(rng: Rng): Paise {
  const roll = rng.next();
  if (roll < 0.55) return rng.int(15_000, 200_000) * 100;
  if (roll < 0.85) return rng.int(200_000, 800_000) * 100;
  if (roll < 0.97) return rng.int(800_000, 2_500_000) * 100;
  return rng.int(2_500_000, 9_000_000) * 100;
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export function generateDataset(options: GenerateOptions = {}): GeneratedDataset {
  const seed = options.seed ?? 20260809;
  const lines = options.lines ?? 600;
  const asOf = options.asOf ?? "2026-08-09";
  const period = options.period ?? "072026";

  const rng = makeRng(seed);
  const purchases: PurchaseRecord[] = [];
  const gstr2b: GSTR2BRecord[] = [];
  const expected: ExpectedOutcome[] = [];

  let pSeq = 0;
  let gSeq = 0;
  const nextP = () => `p${++pSeq}`;
  const nextG = () => `g${++gSeq}`;

  // Per-vendor invoice serial counters, so numbering looks sequential the way
  // a real supplier's would rather than random.
  const serials = new Map<string, number>();
  const nextSerial = (v: VendorFixture) => {
    const n = (serials.get(v.id) ?? rng.int(40, 400)) + rng.int(1, 3);
    serials.set(v.id, n);
    return n;
  };

  // The period being reconciled runs 1–31 July 2026.
  const periodStart = "2026-07-01";
  const periodDays = 31;

  for (let i = 0; i < lines; i++) {
    const vendor = pickVendorWeighted(rng);
    const interState = vendor.state !== BUYER_STATE_CODE;

    // Most lines sit in the period; a slice is deliberately older so the
    // 180-day, MSME and Sec 16(4) clocks have something to bite on.
    const ageRoll = rng.next();
    let invoiceDate: string;
    if (ageRoll < 0.78) {
      invoiceDate = addDays(periodStart, rng.int(0, periodDays - 1));
    } else if (ageRoll < 0.93) {
      invoiceDate = addDays(periodStart, -rng.int(60, 200));
    } else {
      // Prior financial year — candidates for the Sec 16(4) cut-off.
      invoiceDate = addDays(periodStart, -rng.int(370, 500));
    }

    const serial = nextSerial(vendor);
    const invoiceNumber = formatInvoiceNumber(vendor.numberingStyle, vendor.invoicePrefix, serial, invoiceDate);
    const rate = rng.pick(GST_RATES);
    const taxable = drawTaxableValue(rng);
    const tax = buildTax(taxable, rate, interState);

    const isCreditNote = rng.chance(0.035);
    const documentType: DocumentType = isCreditNote ? "CREDIT_NOTE" : "INVOICE";
    const sign = isCreditNote ? -1 : 1;

    const reverseCharge = vendor.sector === "logistics" && rng.chance(0.25);

    const paymentDate = drawPaymentDate(rng, invoiceDate, asOf, vendor.msmeStatus);

    const purchase: PurchaseRecord = {
      id: nextP(),
      supplierGstin: vendor.gstin,
      supplierName: vendor.name,
      invoiceNumber,
      invoiceDate,
      documentType,
      taxableValue: sign * taxable,
      tax: sign === -1 ? negateTax(tax) : tax,
      invoiceValue: sign * (taxable + taxTotal(tax)),
      placeOfSupply: BUYER_STATE_CODE,
      reverseCharge,
      paymentDate,
      msmeStatus: vendor.msmeStatus,
      sourceRow: i + 2,
    };

    // -- Decide what the portal side looks like for this document ------------
    const defect = chooseDefect(rng, vendor, invoiceDate, asOf);

    if (defect === "BOOKS_ONLY") {
      purchases.push(purchase);
      expected.push({
        purchaseId: purchase.id,
        label: "BOOKS_ONLY",
        shouldMatch: false,
        note: `${vendor.name} (${vendor.filingBehaviour}) did not report this invoice`,
      });
      continue;
    }

    if (defect === "BAD_GSTIN") {
      // Typo in the register only. The portal still has the correct GSTIN, so
      // a naive matcher reports this as the vendor's fault when it is ours.
      purchase.supplierGstin = corruptGstinChecksum(vendor.gstin);
      purchases.push(purchase);
      expected.push({
        purchaseId: purchase.id,
        label: "BAD_GSTIN",
        shouldMatch: false,
        note: "Check digit corrupted in the register to simulate a transcription error",
      });
      continue;
    }

    // Build the portal counterpart.
    const g: GSTR2BRecord = {
      id: nextG(),
      supplierGstin: vendor.gstin,
      supplierName: vendor.name,
      invoiceNumber,
      invoiceDate,
      documentType,
      supplyType: documentType === "INVOICE" ? "B2B" : "CDNR",
      taxableValue: purchase.taxableValue,
      tax: { ...purchase.tax },
      invoiceValue: purchase.invoiceValue,
      placeOfSupply: BUYER_STATE_CODE,
      reverseCharge,
      period,
      itcAvailable: "Y",
      supplierFilingPeriod: period,
      supplierGstr3bFiled: true,
    };

    let label: ExpectedLabel = isCreditNote ? "CREDIT_NOTE" : "CLEAN";
    let note = "Exact correspondence";

    switch (defect) {
      case "FORMAT_DRIFT":
        g.invoiceNumber = driftInvoiceNumber(invoiceNumber, rng);
        label = "FORMAT_DRIFT";
        note = `Portal records the number as "${g.invoiceNumber}"`;
        break;

      case "ROUNDING": {
        // A paise-level wobble on one head, within tolerance.
        const nudge = rng.int(1, 99);
        if (g.tax.igst !== 0) g.tax.igst += nudge;
        else g.tax.cgst += nudge;
        label = "ROUNDING";
        note = `Portal tax differs by ${nudge} paise`;
        break;
      }

      case "DATE_DRIFT":
        g.invoiceDate = addDays(invoiceDate, rng.int(1, 3));
        label = "DATE_DRIFT";
        note = "Portal date differs by a few days (goods-receipt vs invoice date)";
        break;

      case "VALUE_MISMATCH": {
        const gap = rng.int(500, 25_000) * 100;
        g.taxableValue = purchase.taxableValue - gap;
        g.tax = buildTax(Math.abs(g.taxableValue), rate, interState);
        if (sign === -1) g.tax = negateTax(g.tax);
        g.invoiceValue = g.taxableValue + taxTotal(g.tax);
        label = "VALUE_MISMATCH";
        note = "Books claim more taxable value than the supplier declared";
        break;
      }

      case "RATE_MISMATCH": {
        const wrongRate = rate === 18 ? 12 : 18;
        g.tax = buildTax(Math.abs(purchase.taxableValue), wrongRate, interState);
        if (sign === -1) g.tax = negateTax(g.tax);
        g.invoiceValue = g.taxableValue + taxTotal(g.tax);
        label = "RATE_MISMATCH";
        note = `Books applied ${rate}%, portal shows ${wrongRate}%`;
        break;
      }

      case "INELIGIBLE":
        g.itcAvailable = "N";
        g.itcUnavailableReason = rng.pick([
          "POS and supplier state are the same, recipient state differs",
          "Return filed after the Sec 16(4) cut-off",
        ]);
        label = "INELIGIBLE";
        note = "Portal flags the credit as unavailable";
        break;

      case "RULE_37A":
        // The dangerous one: present and clean-looking in 2B, but the supplier
        // never paid the tax over.
        g.supplierGstr3bFiled = false;
        label = "RULE_37A";
        note = "Supplier filed GSTR-1 but not GSTR-3B — reversal exposure";
        break;

      case "NONE":
      default:
        break;
    }

    // Independent labels that ride on top of whatever the portal shows.
    if (purchase.reverseCharge) {
      expected.push({
        purchaseId: purchase.id,
        gstr2bId: g.id,
        label: "REVERSE_CHARGE",
        shouldMatch: true,
        note: "Reverse-charge supply",
      });
    }

    purchases.push(purchase);
    gstr2b.push(g);
    expected.push({ purchaseId: purchase.id, gstr2bId: g.id, label, shouldMatch: true, note });
  }

  // -- Portal documents never booked ----------------------------------------
  const orphanCount = Math.max(6, Math.round(lines * 0.02));
  for (let i = 0; i < orphanCount; i++) {
    const vendor = pickVendorWeighted(rng);
    const interState = vendor.state !== BUYER_STATE_CODE;
    const invoiceDate = addDays(periodStart, rng.int(0, periodDays - 1));
    const rate = rng.pick(GST_RATES);
    const taxable = drawTaxableValue(rng);
    const tax = buildTax(taxable, rate, interState);

    const g: GSTR2BRecord = {
      id: nextG(),
      supplierGstin: vendor.gstin,
      supplierName: vendor.name,
      invoiceNumber: formatInvoiceNumber(vendor.numberingStyle, vendor.invoicePrefix, nextSerial(vendor), invoiceDate),
      invoiceDate,
      documentType: "INVOICE",
      supplyType: "B2B",
      taxableValue: taxable,
      tax,
      invoiceValue: taxable + taxTotal(tax),
      placeOfSupply: BUYER_STATE_CODE,
      reverseCharge: false,
      period,
      itcAvailable: "Y",
      supplierFilingPeriod: period,
      supplierGstr3bFiled: true,
    };

    gstr2b.push(g);
    expected.push({
      gstr2bId: g.id,
      label: "GSTR2B_ONLY",
      shouldMatch: false,
      note: "Eligible credit sitting in the portal that was never booked",
    });
  }

  // -- Traps: near-identical documents that must stay apart -----------------
  // These guard the zero-false-positive requirement. Same vendor, adjacent
  // serials, similar amounts — precisely the shape a loose matcher conflates.
  const trapVendors = [VENDORS[3], VENDORS[11], VENDORS[19], VENDORS[27]];
  for (const vendor of trapVendors) {
    const interState = vendor.state !== BUYER_STATE_CODE;
    const invoiceDate = addDays(periodStart, rng.int(2, 20));
    const rate = 18;
    const baseSerial = nextSerial(vendor);

    // Serial N and serial N*10 + adjacent: "0091" vs "0910", and "91" vs "191".
    const pairs: Array<[number, number]> = [
      [baseSerial, baseSerial * 10],
      [baseSerial + 1, 100 + baseSerial + 1],
    ];

    for (const [s1, s2] of pairs) {
      const taxable1 = drawTaxableValue(rng);
      const taxable2 = taxable1 + rng.int(50, 400) * 100;

      for (const [serial, taxable] of [[s1, taxable1], [s2, taxable2]] as const) {
        const number = formatInvoiceNumber(vendor.numberingStyle, vendor.invoicePrefix, serial, invoiceDate);
        const tax = buildTax(taxable, rate, interState);

        const purchase: PurchaseRecord = {
          id: nextP(),
          supplierGstin: vendor.gstin,
          supplierName: vendor.name,
          invoiceNumber: number,
          invoiceDate,
          documentType: "INVOICE",
          taxableValue: taxable,
          tax,
          invoiceValue: taxable + taxTotal(tax),
          placeOfSupply: BUYER_STATE_CODE,
          reverseCharge: false,
          paymentDate: addDays(invoiceDate, 30),
          msmeStatus: vendor.msmeStatus,
        };

        const g: GSTR2BRecord = {
          id: nextG(),
          supplierGstin: vendor.gstin,
          supplierName: vendor.name,
          invoiceNumber: number,
          invoiceDate,
          documentType: "INVOICE",
          supplyType: "B2B",
          taxableValue: taxable,
          tax,
          invoiceValue: taxable + taxTotal(tax),
          placeOfSupply: BUYER_STATE_CODE,
          reverseCharge: false,
          period,
          itcAvailable: "Y",
          supplierFilingPeriod: period,
          supplierGstr3bFiled: true,
        };

        purchases.push(purchase);
        gstr2b.push(g);
        expected.push({
          purchaseId: purchase.id,
          gstr2bId: g.id,
          label: "MUST_NOT_MATCH",
          shouldMatch: true,
          note: `Trap: ${number} must pair only with its own counterpart, not the adjacent serial`,
        });
      }
    }
  }

  return { purchases, gstr2b, expected, asOf, period, seed };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Defect =
  | "NONE"
  | "FORMAT_DRIFT"
  | "ROUNDING"
  | "DATE_DRIFT"
  | "VALUE_MISMATCH"
  | "RATE_MISMATCH"
  | "BOOKS_ONLY"
  | "BAD_GSTIN"
  | "INELIGIBLE"
  | "RULE_37A";

/**
 * Defect probabilities are conditioned on the vendor's filing behaviour, so a
 * punctual vendor rarely goes missing and a defaulter usually does. That
 * correlation is what makes the vendor risk score meaningful rather than noise.
 */
function chooseDefect(rng: Rng, vendor: VendorFixture, invoiceDate: string, asOf: string): Defect {
  const missProbability = {
    PUNCTUAL: 0.01,
    LATE: 0.09,
    ERRATIC: 0.28,
    DEFAULTER: 0.72,
  }[vendor.filingBehaviour];

  if (rng.chance(missProbability)) return "BOOKS_ONLY";
  if (rng.chance(0.012)) return "BAD_GSTIN";

  // Rule 37A concentrates in distressed vendors.
  const r37aProbability = vendor.filingBehaviour === "DEFAULTER" || vendor.filingBehaviour === "ERRATIC" ? 0.14 : 0.02;
  if (rng.chance(r37aProbability)) return "RULE_37A";

  const roll = rng.next();
  if (roll < 0.1) return "FORMAT_DRIFT";
  if (roll < 0.15) return "ROUNDING";
  if (roll < 0.19) return "DATE_DRIFT";
  if (roll < 0.22) return "VALUE_MISMATCH";
  if (roll < 0.24) return "RATE_MISMATCH";
  if (roll < 0.27) return "INELIGIBLE";
  return "NONE";
}

/**
 * Payment timing. Deliberately leaves a slice unpaid past 180 days (Rule 37)
 * and a slice of MSME invoices unpaid past 45 days (Sec 43B(h)), because those
 * two clocks are the ones that drive the pay/hold engine.
 */
function drawPaymentDate(
  rng: Rng,
  invoiceDate: string,
  asOf: string,
  msme: MsmeStatus,
): string | undefined {
  const roll = rng.next();

  // Unpaid.
  if (roll < 0.3) return undefined;

  const isMsme = msme === "MICRO" || msme === "SMALL";
  const terms = isMsme ? rng.int(20, 55) : rng.int(30, 95);
  const paid = addDays(invoiceDate, terms);

  // Cannot have been paid in the future.
  return paid <= asOf ? paid : undefined;
}

/** Weight vendor selection so a handful of suppliers dominate, as in real spend. */
function pickVendorWeighted(rng: Rng): VendorFixture {
  const roll = rng.next();
  // Pareto-ish: 20% of vendors carry roughly 60% of the lines.
  if (roll < 0.6) return VENDORS[rng.int(0, Math.floor(VENDORS.length * 0.2) - 1)];
  return VENDORS[rng.int(0, VENDORS.length - 1)];
}

function negateTax(t: TaxAmounts): TaxAmounts {
  return { igst: -t.igst, cgst: -t.cgst, sgst: -t.sgst, cess: -t.cess };
}

/** Census of the seeded defect classes, for the self-check and the tests. */
export function defectCensus(dataset: GeneratedDataset): Record<string, number> {
  const census: Record<string, number> = {};
  for (const e of dataset.expected) {
    census[e.label] = (census[e.label] ?? 0) + 1;
  }
  return census;
}
