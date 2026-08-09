/**
 * Tunable thresholds for the matching engine.
 *
 * Every number here is a judgement call with money attached, so each one
 * carries its reasoning. They live in one file, versioned, because a CA
 * reviewing our working papers is entitled to ask "why did you treat a ₹0.80
 * gap as rounding?" and get a straight answer.
 */

import type { Paise } from "../domain/types";

export interface MatchConfig {
  /**
   * Per-tax-head gap treated as rounding rather than a real difference.
   *
   * GST is computed to two decimals and then rounded to the nearest rupee at
   * various points by different accounting packages. Tally, SAP and the GST
   * portal disagree at the paise level constantly on the same invoice. ₹1 per
   * head absorbs that without hiding an actual error — a genuine rate or value
   * error is never off by less than a rupee.
   */
  roundingTolerancePerHead: Paise;

  /** Aggregate rounding allowance across all four heads combined. */
  roundingToleranceTotal: Paise;

  /**
   * Taxable-value gap above which we call it a real mismatch worth a human's
   * attention. Below ₹100 the cost of investigating exceeds the exposure for
   * the mid-market volumes we target.
   */
  valueMaterialityThreshold: Paise;

  /**
   * Invoice-date gap still treated as the same document.
   *
   * Books frequently record the goods-receipt date rather than the invoice
   * date, which runs a few days behind for road freight. Beyond a week it is
   * more likely a different document, so we stop absorbing it silently and
   * report the drift.
   */
  dateToleranceDays: number;

  /** Date gap beyond which a pair is not considered at all. */
  dateHardLimitDays: number;

  /**
   * Confidence at or above which the engine resolves a pair without showing
   * it to a human. The product promise is that under 2% of lines reach a
   * person, but a false match is far worse than an extra review, so this sits
   * high deliberately.
   */
  autoAcceptConfidence: number;

  /** Below this, a candidate pair is discarded rather than offered as fuzzy. */
  minCandidateConfidence: number;

  /** Max edit distance on the canonical invoice key for a fuzzy candidate. */
  maxInvoiceEditDistance: number;
}

export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  roundingTolerancePerHead: 100,
  roundingToleranceTotal: 300,
  valueMaterialityThreshold: 10_000,
  dateToleranceDays: 7,
  dateHardLimitDays: 45,
  autoAcceptConfidence: 0.9,
  minCandidateConfidence: 0.55,
  maxInvoiceEditDistance: 2,
};

/**
 * Statutory constants. Separated from matching thresholds because these are
 * not ours to tune — they come from the Act and the Rules, and changing one
 * is a legal event, not a product decision.
 *
 * `effectiveFrom` is recorded so that re-running an old period computes with
 * the rules that applied then rather than today's.
 */
export interface StatutoryConfig {
  /** Rule 37: days from invoice date to pay the supplier before reversal. */
  rule37PaymentDays: number;

  /**
   * Sec 43B(h) of the Income-tax Act: days to pay a registered micro or small
   * enterprise before the deduction is deferred. 45 where a written agreement
   * exists, 15 where it does not. We use 45 as the default because inter-firm
   * supply in this segment almost always has a purchase order behind it, and
   * flag the assumption in the UI.
   */
  msmePaymentDaysWithAgreement: number;
  msmePaymentDaysNoAgreement: number;

  /**
   * Effective corporate tax rate used to price a Sec 43B(h) disallowance.
   * 25% base plus surcharge and cess lands most mid-market companies near 26%.
   * Configurable because it is the one number here that varies by client.
   */
  effectiveTaxRate: number;

  /** Interest on wrongly-availed / reversed credit, per annum. Sec 50. */
  interestRatePerAnnum: number;

  /** Day and month of the Sec 16(4) cut-off following the FY end. */
  sec16_4CutoffMonth: number;
  sec16_4CutoffDay: number;

  /**
   * Rule 37A: if the supplier has not filed GSTR-3B by 30 September following
   * the FY, the recipient must reverse by 30 November.
   */
  rule37aSupplierDeadlineMonth: number;
  rule37aSupplierDeadlineDay: number;
  rule37aReversalMonth: number;
  rule37aReversalDay: number;
}

export const DEFAULT_STATUTORY_CONFIG: StatutoryConfig = {
  rule37PaymentDays: 180,
  msmePaymentDaysWithAgreement: 45,
  msmePaymentDaysNoAgreement: 15,
  effectiveTaxRate: 0.26,
  interestRatePerAnnum: 0.18,
  sec16_4CutoffMonth: 11,
  sec16_4CutoffDay: 30,
  rule37aSupplierDeadlineMonth: 9,
  rule37aSupplierDeadlineDay: 30,
  rule37aReversalMonth: 11,
  rule37aReversalDay: 30,
};
