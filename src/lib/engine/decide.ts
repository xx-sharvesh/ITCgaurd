/**
 * The pay / hold decision engine.
 *
 * This is the part no other GST tool does, and the reason the product is worth
 * a services-grade price rather than a utility-grade one.
 *
 * Every month a finance team decides whether to release a vendor payment. That
 * one decision is squeezed by three provisions that live in two different Acts
 * and pull in opposite directions:
 *
 *   PAY a supplier who never files      → Sec 16(2)(aa): the credit never lands
 *   HOLD an MSME past the limit          → Sec 43B(h): the deduction is deferred
 *   HOLD anyone past 180 days            → Rule 37: the credit reverses, with interest
 *
 * GST software ignores the income-tax leg. AP and ERP software ignores GSTR-2B.
 * So the decision gets made in a WhatsApp group on instinct. Here we price each
 * branch in rupees and recommend the cheapest lawful path, showing the working
 * so the CFO can overrule us with their eyes open.
 *
 * Honesty about the model: the cost of paying depends on whether a delinquent
 * vendor eventually files, which is a probability, not a fact. We estimate it
 * from that vendor's own observed filing history and we label it an estimate
 * everywhere it appears. We do not dress a forecast up as a certainty.
 */

import type {
  ISODate,
  MatchResult,
  Paise,
  PayHoldDecision,
  RiskFinding,
  RiskRuleId,
  VendorPeriodSnapshot,
} from "../domain/types";
import { totalTax } from "../domain/money";
import { addDays, daysBetween } from "../domain/normalize";
import { DEFAULT_STATUTORY_CONFIG, type StatutoryConfig } from "./config";

export interface DecisionContext {
  asOf: ISODate;
  statutory?: StatutoryConfig;
  msmeWrittenAgreement?: boolean;
  /**
   * This vendor's scored history from prior periods, keyed by GSTIN. Optional:
   * omitted, the loss-probability estimate uses this run alone, exactly as it
   * always has. Supplied, a vendor with a consistent track record — good or
   * bad — gets a sharper estimate than one month's snapshot can give.
   */
  vendorHistory?: Record<string, VendorPeriodSnapshot[]>;
}

interface VendorBucket {
  gstin: string;
  name: string;
  matches: MatchResult[];
  findings: RiskFinding[];
}

export function decidePayHold(
  matches: MatchResult[],
  findings: RiskFinding[],
  ctx: DecisionContext,
): PayHoldDecision[] {
  const cfg = ctx.statutory ?? DEFAULT_STATUTORY_CONFIG;
  const buckets = groupByVendor(matches, findings);
  const decisions: PayHoldDecision[] = [];

  for (const bucket of buckets.values()) {
    const decision = decideForVendor(bucket, ctx, cfg, ctx.vendorHistory?.[bucket.gstin]);
    if (decision) decisions.push(decision);
  }

  // Biggest exposure first: this list is worked top-down on a Friday afternoon.
  decisions.sort((a, b) => b.exposure - a.exposure);
  return decisions;
}

function groupByVendor(matches: MatchResult[], findings: RiskFinding[]): Map<string, VendorBucket> {
  const buckets = new Map<string, VendorBucket>();

  for (const m of matches) {
    const rec = m.purchase ?? m.gstr2b;
    if (!rec) continue;
    const key = rec.supplierGstin;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { gstin: key, name: rec.supplierName, matches: [], findings: [] };
      buckets.set(key, bucket);
    }
    bucket.matches.push(m);
  }

  for (const f of findings) {
    const bucket = buckets.get(f.supplierGstin);
    if (bucket) bucket.findings.push(f);
  }

  return buckets;
}

/** Below this many prior periods, a "historical rate" is one data point wearing a percentage sign. */
const MIN_HISTORY_PERIODS_FOR_BLEND = 2;

/**
 * Estimated probability that credit from this vendor never materialises.
 *
 * Derived first from what we can observe in this run: how much of the
 * vendor's billing failed to appear in 2B, and whether they are declaring
 * invoices without paying the tax (the Rule 37A signature, which is a much
 * stronger negative signal than simply filing late).
 *
 * When at least two prior periods are on file, that current-period estimate
 * is blended with the vendor's track record. This is the difference between
 * "one bad month" and "the same bad month for the fourth time running" — two
 * situations this run's data alone cannot tell apart, but history can.
 */
function estimateLossProbability(
  bucket: VendorBucket,
  priorSnapshots?: VendorPeriodSnapshot[],
): { p: number; basis: string } {
  const booksLines = bucket.matches.filter((m) => m.purchase);
  if (booksLines.length === 0) return { p: 0, basis: "No purchases booked against this vendor" };

  // Work in rupees of credit, not counts of invoices. Twenty missing ₹5,000
  // invoices and one missing ₹40 lakh invoice are not the same risk, and a
  // count-based rate would rank them identically.
  let totalCredit = 0;
  let missingCredit = 0;
  let missingCount = 0;

  for (const m of booksLines) {
    const credit = totalTax(m.purchase!.tax);
    if (credit <= 0) continue;
    totalCredit += credit;
    if (m.tier === "BOOKS_ONLY") {
      missingCredit += credit;
      missingCount += 1;
    }
  }

  const r37a = bucket.findings.filter((f) => f.rule === "RULE_37A_SUPPLIER_3B_UNFILED");
  const r37aCredit = r37a.reduce((s, f) => s + f.amountAtRisk, 0);

  if (totalCredit === 0) return { p: 0, basis: "No positive credit booked against this vendor" };

  // Two independent failure modes, each weighted by how likely it is to end in
  // a permanent loss:
  //   absent from 2B     — 0.8, the supplier may still file late
  //   Rule 37A signature — 0.7, invoice declared but tax never paid over
  // Both are scaled by the share of this vendor's credit they actually affect,
  // so a single flagged invoice out of fifty does not condemn the whole account.
  const missShare = Math.min(1, missingCredit / totalCredit);
  const r37aShare = Math.min(1, r37aCredit / totalCredit);

  const currentEstimate = Math.min(0.95, missShare * 0.8 + r37aShare * 0.7);

  const parts: string[] = [];
  if (missingCount > 0) {
    parts.push(
      `${missingCount} of ${booksLines.length} invoices absent from GSTR-2B this period, carrying ${Math.round(missShare * 100)}% of their credit`,
    );
  }
  if (r37a.length > 0) {
    parts.push(
      `${r37a.length} invoice${r37a.length === 1 ? "" : "s"} declared but the tax not paid over (Rule 37A), ${Math.round(r37aShare * 100)}% of their credit`,
    );
  }
  if (parts.length === 0) parts.push(`all ${booksLines.length} invoices reported correctly this period`);

  const eligibleHistory = (priorSnapshots ?? []).filter((s) => s.booksLineCount > 0);
  if (eligibleHistory.length < MIN_HISTORY_PERIODS_FOR_BLEND) {
    return { p: currentEstimate, basis: parts.join("; ") };
  }

  const totalHistoricalLines = eligibleHistory.reduce((s, x) => s + x.booksLineCount, 0);
  const totalHistoricalMissing = eligibleHistory.reduce((s, x) => s + x.missingFrom2bCount, 0);
  const historicalMissRate = totalHistoricalLines > 0 ? totalHistoricalMissing / totalHistoricalLines : 0;
  const historicalEstimate = Math.min(0.95, historicalMissRate * 0.8);

  // Weighted toward this period, because the most recent evidence of whether
  // an invoice actually landed in 2B is still the strongest single signal —
  // history corrects it rather than overriding it.
  const blended = Math.min(0.95, currentEstimate * 0.6 + historicalEstimate * 0.4);

  parts.push(
    `over the last ${eligibleHistory.length} months this vendor has averaged a ${Math.round(historicalMissRate * 100)}% miss rate`,
  );

  return { p: blended, basis: parts.join("; ") };
}

function decideForVendor(
  bucket: VendorBucket,
  ctx: DecisionContext,
  cfg: StatutoryConfig,
  priorSnapshots?: VendorPeriodSnapshot[],
): PayHoldDecision | null {
  // Only unpaid purchase invoices are actually decidable. Everything else is
  // history, and offering a "decision" on a settled invoice is noise.
  const open = bucket.matches.filter(
    (m) => m.purchase && !m.purchase.paymentDate && m.purchase.documentType === "INVOICE",
  );
  if (open.length === 0) return null;

  const exposure = open.reduce((sum, m) => sum + (m.purchase?.invoiceValue ?? 0), 0);
  if (exposure === 0) return null;

  const creditAtStake = open.reduce((sum, m) => sum + totalTax(m.purchase!.tax), 0);
  const taxableAtStake = open.reduce((sum, m) => sum + m.purchase!.taxableValue, 0);

  const { p: lossProbability, basis } = estimateLossProbability(bucket, priorSnapshots);

  // ---- Cost of paying now -------------------------------------------------
  // Release the money and the leverage goes with it. If the vendor never
  // files, the credit is lost and there is nothing left to withhold.
  const costOfPaying = Math.round(creditAtStake * lossProbability);

  // ---- Cost of holding ----------------------------------------------------
  const holdCosts: Array<{ amount: Paise; why: string; rule: RiskRuleId }> = [];

  const isMsme = open.some(
    (m) => m.purchase?.msmeStatus === "MICRO" || m.purchase?.msmeStatus === "SMALL",
  );
  if (isMsme) {
    const limit = ctx.msmeWrittenAgreement === false
      ? cfg.msmePaymentDaysNoAgreement
      : cfg.msmePaymentDaysWithAgreement;

    const overdueMsme = open.filter(
      (m) =>
        (m.purchase?.msmeStatus === "MICRO" || m.purchase?.msmeStatus === "SMALL") &&
        daysBetween(m.purchase!.invoiceDate, ctx.asOf) > limit,
    );

    if (overdueMsme.length > 0) {
      const base = overdueMsme.reduce((s, m) => s + m.purchase!.taxableValue, 0);
      holdCosts.push({
        amount: Math.round(base * cfg.effectiveTaxRate),
        why: `Registered MSME supplier already past the ${limit}-day limit — the deduction on ${overdueMsme.length} invoice${overdueMsme.length === 1 ? "" : "s"} is deferred to the year of payment under Sec 43B(h)`,
        rule: "SEC_43B_H_MSME_OVERDUE",
      });
    }
  }

  // Rule 37 bites at 180 days. Only the interest is a true loss — the credit
  // itself comes back when the payment is finally made.
  const near180 = open.filter(
    (m) => daysBetween(m.purchase!.invoiceDate, ctx.asOf) > cfg.rule37PaymentDays - 30,
  );
  if (near180.length > 0) {
    const credit = near180.reduce((s, m) => s + totalTax(m.purchase!.tax), 0);
    const worstDays = Math.max(
      ...near180.map((m) => daysBetween(m.purchase!.invoiceDate, ctx.asOf) - cfg.rule37PaymentDays),
    );
    const days = Math.max(worstDays, 0);
    const interest = Math.round((credit * cfg.interestRatePerAnnum * Math.max(days, 30)) / 365);
    holdCosts.push({
      amount: interest,
      why:
        days > 0
          ? `${near180.length} invoice${near180.length === 1 ? " is" : "s are"} already past 180 days — credit must be reversed with interest under Rule 37`
          : `${near180.length} invoice${near180.length === 1 ? "" : "s"} within 30 days of the 180-day Rule 37 limit`,
      rule: "RULE_37_180_DAY",
    });
  }

  const costOfHolding = holdCosts.reduce((s, c) => s + c.amount, 0);

  // ---- Verdict ------------------------------------------------------------
  const rationale: string[] = [];
  let verdict: PayHoldDecision["verdict"];
  let bindingConstraint: RiskRuleId | "NONE" = "NONE";

  rationale.push(`Estimated ${formatProbability(lossProbability)} chance this credit never lands — ${basis}.`);

  const worstHoldCost = [...holdCosts].sort((a, b) => b.amount - a.amount)[0];
  const costsAreClose =
    costOfPaying > 0 &&
    costOfHolding > 0 &&
    Math.abs(costOfPaying - costOfHolding) / Math.max(costOfPaying, costOfHolding) < 0.25;

  /**
   * Ordered by decreasing force, and deliberately reluctant to reach for a
   * full withhold.
   *
   * Withholding the entire balance is a commercial act, not an arithmetic one:
   * it strains the supplier's working capital and the relationship. It is only
   * proportionate when a large share of the credit is genuinely in doubt.
   * Below that, withholding just the tax component protects exactly the amount
   * at risk and nothing more — the same protection at a fraction of the
   * commercial cost.
   */
  if (costOfHolding > costOfPaying && costOfHolding > 0) {
    verdict = "PAY";
    bindingConstraint = worstHoldCost.rule;
    rationale.push("Holding costs more than the credit at risk. " + holdCosts.map((c) => c.why).join("; ") + ".");
    rationale.push("Pay, and pursue the credit through the chase loop rather than by withholding cash.");
  } else if (costsAreClose) {
    verdict = "ESCALATE";
    rationale.push(
      "The cost of paying and the cost of holding are within a quarter of each other, so this is a commercial " +
        "judgement rather than an arithmetic one. Both figures are shown so it can be decided on the facts.",
    );
    if (worstHoldCost) {
      bindingConstraint = worstHoldCost.rule;
      rationale.push(holdCosts.map((c) => c.why).join("; ") + ".");
    }
  } else if (lossProbability >= 0.35) {
    verdict = "HOLD";
    bindingConstraint = "SEC_16_2_AA_NOT_IN_2B";
    rationale.push(
      `A substantial share of this vendor's credit is already failing to arrive, so withholding the full balance ` +
        `of ${formatShare(exposure, exposure)} is proportionate. Release on evidence of filing.`,
    );
  } else if (lossProbability >= 0.05) {
    // The leverage play: settle the goods value, withhold only the tax
    // component until the credit appears in 2B. Standard practice in Indian
    // industry, keeps the vendor solvent, and it is the tax that is at risk —
    // not the goods value.
    verdict = "PAY_NET_OF_GST";
    bindingConstraint = "SEC_16_2_AA_NOT_IN_2B";
    rationale.push(
      `Only ${formatShare(creditAtStake, exposure)} of this balance is tax, and that is the whole of what is at risk. ` +
        "Withholding the entire payment would be disproportionate.",
    );
    rationale.push(
      "Release the taxable value and retain the tax until the invoice appears in GSTR-2B. This protects exactly " +
        "the amount at risk while keeping the supplier relationship and their working capital intact.",
    );
  } else {
    verdict = "PAY";
    rationale.push("Vendor is filing reliably and no payment clock is close to expiring. Release normally.");
  }

  if (verdict === "PAY_NET_OF_GST") {
    rationale.push(
      `Release approximately ${formatShare(taxableAtStake, exposure)} of the outstanding balance; retain the tax component.`,
    );
  }

  rationale.push(
    "Loss probability is an estimate from this vendor's own filing record in this run, not a certainty.",
  );

  // The soonest date at which a new cost appears if nothing is done.
  const decideBy = earliestDeadline(open, ctx, cfg);

  return {
    supplierGstin: bucket.gstin,
    supplierName: bucket.name,
    matchIds: open.map((m) => m.id),
    exposure,
    verdict,
    costOfPaying,
    costOfHolding,
    rationale,
    bindingConstraint,
    decideBy,
  };
}

function earliestDeadline(
  open: MatchResult[],
  ctx: DecisionContext,
  cfg: StatutoryConfig,
): ISODate | undefined {
  const limit = ctx.msmeWrittenAgreement === false
    ? cfg.msmePaymentDaysNoAgreement
    : cfg.msmePaymentDaysWithAgreement;

  const dates: ISODate[] = [];
  for (const m of open) {
    const p = m.purchase!;
    dates.push(addDays(p.invoiceDate, cfg.rule37PaymentDays));
    if (p.msmeStatus === "MICRO" || p.msmeStatus === "SMALL") {
      dates.push(addDays(p.invoiceDate, limit));
    }
  }

  const future = dates.filter((d) => daysBetween(ctx.asOf, d) >= 0).sort();
  // Everything already lapsed still deserves a date — show the earliest breach
  // rather than nothing at all.
  return future[0] ?? dates.sort()[0];
}

function formatShare(part: Paise, whole: Paise): string {
  if (whole === 0) return "0%";
  const pct = (part / whole) * 100;
  if (pct > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

/**
 * Never render a non-zero risk as "0%". A reader who sees 0% next to a list of
 * defects concludes the tool is broken, and they are half right.
 */
function formatProbability(p: number): string {
  if (p <= 0) return "no measurable";
  if (p < 0.01) return "under 1%";
  return `${Math.round(p * 100)}%`;
}
