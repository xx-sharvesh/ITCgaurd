/**
 * The matching engine.
 *
 * Ties each line in the purchase register to its counterpart in GSTR-2B.
 *
 * Design principle, and the one that shapes everything below: a FALSE MATCH is
 * catastrophic and a MISSED MATCH is merely annoying. If we wrongly pair two
 * documents, we tell a CFO their credit is safe when it is not, and they find
 * out from a departmental notice eighteen months later. If we fail to pair two
 * documents, a human spends ninety seconds resolving it. The scoring below is
 * therefore asymmetric on purpose: every loosening of one field demands
 * corroboration from another, and the fuzzy tier cannot fire on invoice
 * similarity alone.
 *
 * Shape of the algorithm:
 *   1. Block candidates by supplier, so we never compare across vendors.
 *   2. Score every candidate pair within a block on independent evidence.
 *   3. Assign greedily, strongest first, one-to-one.
 *   4. Whatever is left over is a one-sided finding.
 */

import type {
  FieldDelta,
  GSTR2BRecord,
  MatchResult,
  MatchTier,
  Paise,
  PurchaseRecord,
  TaxAmounts,
} from "../domain/types";
import { absDelta, totalTax } from "../domain/money";
import { normalizeGstin, panFromGstin } from "../domain/gstin";
import {
  boundedLevenshtein,
  daysBetween,
  invoiceKeyWithoutFY,
  invoiceKeys,
  vendorNameKey,
} from "../domain/normalize";
import { DEFAULT_MATCH_CONFIG, type MatchConfig } from "./config";

// ---------------------------------------------------------------------------
// Candidate scoring
// ---------------------------------------------------------------------------

interface Candidate {
  purchase: PurchaseRecord;
  gstr2b: GSTR2BRecord;
  confidence: number;
  tier: MatchTier;
  reasons: string[];
  deltas: FieldDelta[];
}

/** Independent signals. Kept separate so the reasons we show are honest. */
interface Evidence {
  supplierScore: number;
  supplierReason: string;
  invoiceScore: number;
  invoiceReason: string;
  amountScore: number;
  amountReason: string;
  dateScore: number;
  dateReason: string;
}

function scoreSupplier(p: PurchaseRecord, g: GSTR2BRecord): { score: number; reason: string } | null {
  const pg = normalizeGstin(p.supplierGstin);
  const gg = normalizeGstin(g.supplierGstin);

  if (pg && pg === gg) return { score: 1, reason: "Supplier GSTIN identical" };

  // A wrong state code or a mistyped check digit still leaves the PAN intact.
  // Same PAN means the same legal entity, so this is a real candidate — but a
  // weaker one, because two GSTINs of one PAN are genuinely different
  // registrations and their invoices must not be conflated without support.
  const pPan = panFromGstin(pg);
  const gPan = panFromGstin(gg);
  if (pPan && gPan && pPan === gPan) {
    return { score: 0.75, reason: "Same PAN, different GSTIN — likely a state-code or check-digit typo" };
  }

  // Last resort: identical trading name. Only ever enough to nominate a
  // candidate; the amount and invoice number have to carry the decision.
  const pName = vendorNameKey(p.supplierName);
  const gName = vendorNameKey(g.supplierName);
  if (pName && pName === gName && pName.length >= 6) {
    return { score: 0.45, reason: "Supplier name matches but GSTIN does not" };
  }

  return null;
}

/**
 * How strongly two invoice numbers indicate the same document, 0..1.
 *
 * Exported so the tier ladder can be tested directly against the hand-labelled
 * golden set. Anything scoring at or above IDENTITY_THRESHOLD establishes
 * identity on its own; anything below it is only ever a candidate, and the
 * caller must corroborate with amounts before pairing.
 */
export function invoiceSimilarity(
  aRaw: string,
  bRaw: string,
  cfg: MatchConfig = DEFAULT_MATCH_CONFIG,
): { score: number; reason: string } {
  const a = invoiceKeys(aRaw);
  const b = invoiceKeys(bRaw);

  if (a.strict && a.strict === b.strict) {
    return { score: 1, reason: "Invoice number identical" };
  }
  if (a.loose && a.loose === b.loose) {
    return { score: 0.95, reason: "Invoice number matches ignoring leading zeros and separators" };
  }

  const aNoFy = invoiceKeyWithoutFY(aRaw);
  const bNoFy = invoiceKeyWithoutFY(bRaw);
  if (aNoFy && aNoFy === bNoFy) {
    // Deliberately below IDENTITY_THRESHOLD. Suppliers restart their serial
    // every April, so "INV/2026-27/0091" and "INV/2025-26/0091" collide the
    // instant the year is stripped — and they are two different invoices a
    // year apart. This tier nominates a candidate; the amounts decide.
    return { score: 0.82, reason: "Invoice number matches once the financial-year fragment is removed" };
  }

  // A shared numeric tail is weak on its own — "91" is the tail of a great
  // many invoices — so it scores low and can only survive with a strong
  // amount match behind it.
  if (a.numericTail && a.numericTail === b.numericTail && a.numericTail.length >= 3) {
    return { score: 0.6, reason: `Invoice serial ${a.numericTail} matches, prefix differs` };
  }

  const distance = boundedLevenshtein(a.loose, b.loose, cfg.maxInvoiceEditDistance);
  if (distance <= cfg.maxInvoiceEditDistance && a.loose.length >= 5) {
    // Guard against the classic false positive: "INV91" vs "INV191" is edit
    // distance 1 but they are two different invoices. Require the digit runs
    // to be the same length, so a *substitution* passes and an *insertion*
    // into the serial does not.
    const aDigits = a.loose.replace(/\D/g, "");
    const bDigits = b.loose.replace(/\D/g, "");
    if (aDigits.length === bDigits.length) {
      return {
        score: distance === 1 ? 0.72 : 0.62,
        reason: `Invoice number differs by ${distance} character${distance === 1 ? "" : "s"} — probable transcription slip`,
      };
    }
  }

  return { score: 0, reason: "Invoice number does not correspond" };
}

/**
 * At or above this, the invoice number alone establishes that two rows are the
 * same document. Below it, amounts must agree within rounding before the pair
 * may be committed — see the corroboration gate in `evaluate`.
 */
export const IDENTITY_THRESHOLD = 0.85;

function scoreInvoiceNumber(p: PurchaseRecord, g: GSTR2BRecord, cfg: MatchConfig) {
  return invoiceSimilarity(p.invoiceNumber, g.invoiceNumber, cfg);
}

function scoreAmounts(
  p: PurchaseRecord,
  g: GSTR2BRecord,
  cfg: MatchConfig,
): { score: number; reason: string; deltas: FieldDelta[] } {
  const deltas: FieldDelta[] = [];

  const taxableGap = absDelta(p.taxableValue, g.taxableValue);
  const pTax = totalTax(p.tax);
  const gTax = totalTax(g.tax);
  const taxGap = absDelta(pTax, gTax);

  const headGaps: Array<[keyof TaxAmounts, Paise]> = [
    ["igst", absDelta(p.tax.igst, g.tax.igst)],
    ["cgst", absDelta(p.tax.cgst, g.tax.cgst)],
    ["sgst", absDelta(p.tax.sgst, g.tax.sgst)],
    ["cess", absDelta(p.tax.cess, g.tax.cess)],
  ];

  const everyHeadExact = headGaps.every(([, gap]) => gap === 0);
  const everyHeadWithinTolerance = headGaps.every(([, gap]) => gap <= cfg.roundingTolerancePerHead);

  if (taxableGap === 0 && everyHeadExact) {
    return { score: 1, reason: "Taxable value and every tax head identical", deltas };
  }

  if (
    taxableGap <= cfg.roundingToleranceTotal &&
    everyHeadWithinTolerance &&
    taxGap <= cfg.roundingToleranceTotal
  ) {
    return {
      score: 0.94,
      reason: "Amounts agree within rounding tolerance",
      deltas,
    };
  }

  // Beyond tolerance the pair may still be the same document with a genuine
  // error on one side, which is precisely what the user needs to see. Record
  // the deltas and let the invoice number and date decide whether it is the
  // same document at all.
  if (taxableGap > cfg.roundingToleranceTotal) {
    deltas.push({
      field: "taxableValue",
      books: p.taxableValue,
      portal: g.taxableValue,
      deltaPaise: p.taxableValue - g.taxableValue,
    });
  }
  for (const [head, gap] of headGaps) {
    if (gap > cfg.roundingTolerancePerHead) {
      deltas.push({
        field: head,
        books: p.tax[head],
        portal: g.tax[head],
        deltaPaise: p.tax[head] - g.tax[head],
      });
    }
  }

  // Relative closeness still carries information: a 0.5% gap on a ₹10L invoice
  // is a rounding-policy difference, a 40% gap is a different document.
  const scale = Math.max(p.taxableValue, g.taxableValue, 1);
  const relative = taxableGap / scale;

  if (relative <= 0.02) {
    return { score: 0.75, reason: "Taxable values differ slightly", deltas };
  }
  if (relative <= 0.2) {
    return { score: 0.45, reason: "Taxable values differ materially", deltas };
  }
  return { score: 0.1, reason: "Amounts are far apart", deltas };
}

function scoreDate(
  p: PurchaseRecord,
  g: GSTR2BRecord,
  cfg: MatchConfig,
): { score: number; reason: string; deltas: FieldDelta[] } {
  const deltas: FieldDelta[] = [];
  const gap = Math.abs(daysBetween(p.invoiceDate, g.invoiceDate));

  if (gap === 0) return { score: 1, reason: "Invoice date identical", deltas };

  if (gap <= cfg.dateToleranceDays) {
    deltas.push({ field: "invoiceDate", books: p.invoiceDate, portal: g.invoiceDate });
    return {
      score: 0.85,
      reason: `Invoice date differs by ${gap} day${gap === 1 ? "" : "s"}`,
      deltas,
    };
  }

  if (gap <= cfg.dateHardLimitDays) {
    deltas.push({ field: "invoiceDate", books: p.invoiceDate, portal: g.invoiceDate });
    return { score: 0.4, reason: `Invoice date differs by ${gap} days`, deltas };
  }

  return { score: 0, reason: `Invoice date differs by ${gap} days — beyond plausible drift`, deltas };
}

/**
 * Combine evidence into a confidence and a tier.
 *
 * The weights are not arbitrary. Supplier identity and invoice number are what
 * make two rows *the same document*; amount and date are what make it *the
 * same document recorded correctly*. So identity is gated (a pair cannot
 * proceed at all without it) while amount and date modulate the tier.
 */
function combine(
  p: PurchaseRecord,
  g: GSTR2BRecord,
  ev: Evidence,
  amountDeltas: FieldDelta[],
  dateDeltas: FieldDelta[],
  cfg: MatchConfig,
): Candidate | null {
  const identity = ev.supplierScore * ev.invoiceScore;

  // No credible identity link — never a candidate, regardless of how neatly
  // the amounts happen to line up. Two different invoices from one vendor for
  // the same monthly retainer have identical amounts every month.
  if (identity < 0.3) return null;

  const confidence =
    ev.supplierScore * 0.3 + ev.invoiceScore * 0.34 + ev.amountScore * 0.26 + ev.dateScore * 0.1;

  if (confidence < cfg.minCandidateConfidence) return null;

  const deltas = [...amountDeltas, ...dateDeltas];
  const reasons = [ev.supplierReason, ev.invoiceReason, ev.amountReason, ev.dateReason];

  let tier: MatchTier;
  if (ev.supplierScore === 1 && ev.invoiceScore === 1 && ev.amountScore === 1 && ev.dateScore === 1) {
    tier = "EXACT";
  } else if (ev.amountScore >= 0.94 && ev.invoiceScore >= 0.85 && ev.dateScore >= 0.85 && ev.supplierScore === 1) {
    tier = "TOLERANT";
  } else if (confidence >= cfg.autoAcceptConfidence && deltas.length > 0) {
    // Confident it is the same document, and confident something about it is
    // recorded wrongly. This is the useful finding, not an error state.
    tier = "MISMATCH";
  } else if (identity >= 0.85 && ev.amountScore >= 0.45) {
    tier = "MISMATCH";
  } else {
    tier = "FUZZY";
  }

  return { purchase: p, gstr2b: g, confidence, tier, reasons, deltas };
}

function evaluate(p: PurchaseRecord, g: GSTR2BRecord, cfg: MatchConfig): Candidate | null {
  // A credit note and an invoice are different instruments. Pairing them would
  // invert the sign of the credit, so this is a hard gate rather than a score.
  if (p.documentType !== g.documentType) return null;

  const supplier = scoreSupplier(p, g);
  if (!supplier) return null;

  const invoice = scoreInvoiceNumber(p, g, cfg);
  if (invoice.score === 0) return null;

  const amount = scoreAmounts(p, g, cfg);
  const date = scoreDate(p, g, cfg);
  if (date.score === 0) return null;

  // Corroboration gate.
  //
  // Only the top two invoice tiers (identical, or identical once separators
  // and leading zeros are normalised) establish identity on their own.
  // Everything below that — a shared numeric tail, or a one-character edit
  // distance — is far more often two adjacent invoices from the same vendor
  // than a transcription slip. "SCS/2026-27/0185" and "SCS/2026-27/0188" are
  // edit distance 1 and are simply different invoices.
  //
  // So anything weaker than 0.85 must be rescued by amounts agreeing to
  // within rounding. A genuine typo still matches, because the amounts on a
  // mistyped invoice number are unchanged; a neighbouring invoice does not,
  // because its amounts differ.
  if (invoice.score < 0.85 && amount.score < 0.94) return null;
  if (supplier.score < 1 && invoice.score < 0.95 && amount.score < 0.94) return null;

  const ev: Evidence = {
    supplierScore: supplier.score,
    supplierReason: supplier.reason,
    invoiceScore: invoice.score,
    invoiceReason: invoice.reason,
    amountScore: amount.score,
    amountReason: amount.reason,
    dateScore: date.score,
    dateReason: date.reason,
  };

  return combine(p, g, ev, amount.deltas, date.deltas, cfg);
}

// ---------------------------------------------------------------------------
// Blocking
// ---------------------------------------------------------------------------

/**
 * Group 2B records into buckets that a given purchase line could plausibly
 * match, so we compare against a handful of rows instead of the whole file.
 * Without this, a 10,000-line register against a 10,000-line 2B is 100 million
 * comparisons; with it, a few hundred thousand.
 */
function buildIndex(records: GSTR2BRecord[]) {
  const byGstin = new Map<string, GSTR2BRecord[]>();
  const byPan = new Map<string, GSTR2BRecord[]>();
  const byName = new Map<string, GSTR2BRecord[]>();

  for (const r of records) {
    const gstin = normalizeGstin(r.supplierGstin);
    push(byGstin, gstin, r);

    const pan = panFromGstin(gstin);
    if (pan) push(byPan, pan, r);

    const name = vendorNameKey(r.supplierName);
    if (name.length >= 6) push(byName, name, r);
  }

  return { byGstin, byPan, byName };
}

function push<T>(map: Map<string, T[]>, key: string, value: T) {
  if (!key) return;
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface ReconcileOptions {
  config?: MatchConfig;
}

/**
 * Reconcile books against the portal.
 *
 * Returns one MatchResult per resolved pair plus one per unmatched record on
 * either side, so the output always accounts for every input line. That
 * completeness is what makes the control totals tie, and the control totals
 * are what make a CA trust the tool.
 */
export function reconcile(
  purchases: PurchaseRecord[],
  gstr2b: GSTR2BRecord[],
  options: ReconcileOptions = {},
): MatchResult[] {
  const cfg = options.config ?? DEFAULT_MATCH_CONFIG;
  const index = buildIndex(gstr2b);

  // Gather every plausible pairing before committing to any of them. Deciding
  // greedily as we walk the register would let an early mediocre pair consume
  // a 2B row that a later line matches perfectly.
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  for (const p of purchases) {
    const gstin = normalizeGstin(p.supplierGstin);
    const pan = panFromGstin(gstin);
    const name = vendorNameKey(p.supplierName);

    const pool: GSTR2BRecord[] = [
      ...(index.byGstin.get(gstin) ?? []),
      ...(pan ? index.byPan.get(pan) ?? [] : []),
      ...(name.length >= 6 ? index.byName.get(name) ?? [] : []),
    ];

    const considered = new Set<string>();
    for (const g of pool) {
      if (considered.has(g.id)) continue;
      considered.add(g.id);

      const pairKey = `${p.id}::${g.id}`;
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);

      const candidate = evaluate(p, g, cfg);
      if (candidate) candidates.push(candidate);
    }
  }

  // Strongest first. Ties break toward the tighter tier, then toward the
  // smaller ITC delta, so that deterministic output does not depend on input
  // ordering — a reconciliation that changes when you re-sort the spreadsheet
  // is a reconciliation nobody will trust.
  const tierRank: Record<MatchTier, number> = {
    EXACT: 0, TOLERANT: 1, MISMATCH: 2, FUZZY: 3, BOOKS_ONLY: 4, GSTR2B_ONLY: 5,
  };
  candidates.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (tierRank[a.tier] !== tierRank[b.tier]) return tierRank[a.tier] - tierRank[b.tier];
    const aDelta = Math.abs(itcDelta(a.purchase, a.gstr2b));
    const bDelta = Math.abs(itcDelta(b.purchase, b.gstr2b));
    if (aDelta !== bDelta) return aDelta - bDelta;
    return a.purchase.id.localeCompare(b.purchase.id);
  });

  const usedPurchase = new Set<string>();
  const usedGstr2b = new Set<string>();
  const results: MatchResult[] = [];

  for (const c of candidates) {
    if (usedPurchase.has(c.purchase.id) || usedGstr2b.has(c.gstr2b.id)) continue;
    usedPurchase.add(c.purchase.id);
    usedGstr2b.add(c.gstr2b.id);

    results.push({
      id: `m-${c.purchase.id}-${c.gstr2b.id}`,
      tier: c.tier,
      purchase: c.purchase,
      gstr2b: c.gstr2b,
      confidence: round3(c.confidence),
      reasons: c.reasons.filter(Boolean),
      deltas: c.deltas,
      itcDeltaPaise: itcDelta(c.purchase, c.gstr2b),
    });
  }

  for (const p of purchases) {
    if (usedPurchase.has(p.id)) continue;
    results.push({
      id: `m-${p.id}-none`,
      tier: "BOOKS_ONLY",
      purchase: p,
      confidence: 1,
      reasons: ["No corresponding document found in GSTR-2B"],
      deltas: [],
      itcDeltaPaise: totalTax(p.tax),
    });
  }

  for (const g of gstr2b) {
    if (usedGstr2b.has(g.id)) continue;
    results.push({
      id: `m-none-${g.id}`,
      tier: "GSTR2B_ONLY",
      gstr2b: g,
      confidence: 1,
      reasons: ["Present in GSTR-2B but not recorded in the purchase register"],
      deltas: [],
      itcDeltaPaise: -totalTax(g.tax),
    });
  }

  return results;
}

function itcDelta(p: PurchaseRecord, g: GSTR2BRecord): Paise {
  return totalTax(p.tax) - totalTax(g.tax);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Share of results that needed no human review. The product's core promise. */
export function autoResolvedRatio(matches: MatchResult[]): number {
  if (matches.length === 0) return 1;
  const auto = matches.filter((m) => m.tier === "EXACT" || m.tier === "TOLERANT").length;
  return auto / matches.length;
}
