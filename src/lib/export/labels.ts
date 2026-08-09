/**
 * Export vocabulary — the single source of truth for every human-readable
 * string that describes a domain enum.
 *
 * Why this file exists: the screen and the Excel working paper are read by two
 * different people (the CFO and their CA) who WILL compare them. If the app
 * says "Supplier hasn't filed 3B" and the workbook says "Rule 37A breach", the
 * CA assumes the two numbers are different numbers and the trust is gone.
 * Both surfaces import from here, so the wording is physically incapable of
 * drifting apart.
 *
 * Nothing in this file computes money. It maps enums to words.
 */

import type {
  MatchTier,
  MsmeStatus,
  RecommendedAction,
  RiskRuleId,
  Severity,
  VendorProfile,
  PayHoldDecision,
} from "@/lib/domain/types";

// ---------------------------------------------------------------------------
// Export metadata
// ---------------------------------------------------------------------------

/**
 * Who this working paper belongs to and when it was produced.
 *
 * `generatedAt` is an ISO timestamp. Its first 10 characters are used verbatim
 * as the report's calendar date, so the OFFSET YOU ENCODE DECIDES THE DATE:
 * pass "2026-08-08T23:35:00+05:30" to stamp the IST date, or a `Z` instant to
 * stamp the UTC date. We deliberately do not call any local-timezone API here —
 * this model is rendered on both the server and the client in Next.js, and a
 * timezone-dependent date would produce a hydration mismatch and, worse, two
 * different dates on the same document.
 */
export interface ExportMeta {
  companyName: string;
  companyGstin: string;
  /** GST return period, `MMYYYY` — e.g. "072026". */
  period: string;
  /** ISO timestamp. See the note above about offsets. */
  generatedAt: string;
  preparedBy?: string;
}

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

/**
 * Sort order for severity. Lower rank sorts first, i.e. CRITICAL at the top of
 * every list — a working paper that buries the critical finding on page four
 * has failed at its only job.
 */
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = Object.freeze({
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
});

export const SEVERITY_LABELS: Readonly<Record<Severity, string>> = Object.freeze({
  CRITICAL: "Critical",
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
});

/** Comparator for `Array.prototype.sort` — most severe first. */
export function compareSeverity(a: Severity, b: Severity): number {
  return SEVERITY_RANK[a] - SEVERITY_RANK[b];
}

// ---------------------------------------------------------------------------
// Risk rules
// ---------------------------------------------------------------------------

export interface RiskRuleMeta {
  /** Short column-width label. Used as a table cell and a chart legend. */
  label: string;
  /**
   * Statutory citation. This is what a CA verifies our reasoning against, so
   * it names the provision precisely rather than paraphrasing it.
   */
  citation: string;
  /** One line a CFO understands without opening the Act. */
  plain: string;
  /**
   * Inherent severity of the rule. This is a DEFAULT for display where no
   * finding is in hand (legends, filters, empty states). Where a RiskFinding
   * exists, its own `severity` is authoritative and must win — the engine can
   * downgrade a rule on the facts of a specific invoice.
   */
  defaultSeverity: Severity;
}

export const RISK_RULES: Readonly<Record<RiskRuleId, RiskRuleMeta>> = Object.freeze({
  SEC_16_2_AA_NOT_IN_2B: {
    label: "Not in GSTR-2B",
    citation: "Sec 16(2)(aa) CGST Act, 2017",
    plain:
      "You claimed this credit but the supplier never reported the invoice, so it does not appear in your GSTR-2B. Credit is not legally available until it does.",
    defaultSeverity: "CRITICAL",
  },
  ITC_MARKED_INELIGIBLE: {
    label: "Portal marked ineligible",
    citation: "Sec 17(5) CGST Act, 2017 (GSTR-2B eligibility flag)",
    plain:
      "The GST portal itself has flagged this credit as not available to you. Claiming it anyway is the fastest route to a notice.",
    defaultSeverity: "CRITICAL",
  },
  RULE_37_180_DAY: {
    label: "180-day non-payment",
    citation: "Rule 37 CGST Rules r/w 2nd proviso to Sec 16(2) CGST Act",
    plain:
      "The supplier has not been paid within 180 days of the invoice date, so the credit already taken must be reversed with interest.",
    defaultSeverity: "HIGH",
  },
  RULE_37A_SUPPLIER_3B_UNFILED: {
    label: "Supplier GSTR-3B unfiled",
    citation: "Rule 37A CGST Rules, 2017",
    plain:
      "The supplier declared this invoice in GSTR-1 but never paid the tax over in GSTR-3B. The law makes you reverse the credit, not them.",
    defaultSeverity: "HIGH",
  },
  SEC_16_4_TIME_BARRED: {
    label: "Claim window closing",
    citation: "Sec 16(4) CGST Act, 2017",
    plain:
      "Credit on this invoice can only be claimed until 30 November following the end of its financial year. After that date the money is gone permanently.",
    defaultSeverity: "CRITICAL",
  },
  VALUE_MISMATCH: {
    label: "Value mismatch",
    citation: "Sec 16(2)(aa) CGST Act r/w Rule 36 CGST Rules",
    plain:
      "Your books and the supplier's filing disagree on what this invoice was worth. Only the lower of the two amounts is safely claimable.",
    defaultSeverity: "MEDIUM",
  },
  IN_2B_NOT_IN_BOOKS: {
    label: "Unclaimed credit in 2B",
    citation: "Sec 16(4) CGST Act, 2017 (claim window)",
    plain:
      "The portal shows credit you are entitled to but have not booked. This is money you are owed — claim it before the Sec 16(4) window closes.",
    defaultSeverity: "LOW",
  },
  SEC_43B_H_MSME_OVERDUE: {
    label: "MSME payment overdue",
    citation: "Sec 43B(h) Income-tax Act, 1961 r/w Sec 15 MSMED Act, 2006",
    plain:
      "This micro/small supplier is unpaid beyond the MSMED limit, so the entire expense is disallowed as a deduction in this year's income-tax computation.",
    defaultSeverity: "HIGH",
  },
  INVALID_OR_CANCELLED_GSTIN: {
    label: "Invalid / cancelled GSTIN",
    citation: "Sec 16(2)(a) CGST Act r/w Rule 36(1) CGST Rules",
    plain:
      "The supplier's GSTIN fails validation or is no longer active, so the document does not qualify as a valid tax invoice for credit.",
    defaultSeverity: "CRITICAL",
  },
});

/** Every rule id, ordered most-severe-first then alphabetically. Stable. */
export const RISK_RULE_IDS: readonly RiskRuleId[] = Object.freeze(
  (Object.keys(RISK_RULES) as RiskRuleId[]).sort((a, b) => {
    const bySeverity = compareSeverity(RISK_RULES[a].defaultSeverity, RISK_RULES[b].defaultSeverity);
    return bySeverity !== 0 ? bySeverity : a.localeCompare(b);
  }),
);

export function riskRuleLabel(rule: RiskRuleId): string {
  return RISK_RULES[rule]?.label ?? rule;
}

export function riskRuleCitation(rule: RiskRuleId): string {
  return RISK_RULES[rule]?.citation ?? "";
}

export function riskRulePlain(rule: RiskRuleId): string {
  return RISK_RULES[rule]?.plain ?? "";
}

// ---------------------------------------------------------------------------
// Recommended actions
// ---------------------------------------------------------------------------

/**
 * Imperative, present tense, no hedging. The CFO forwards this cell straight
 * to their accounts payable clerk; "consider reviewing the position" is not an
 * instruction anyone can execute.
 */
export const RECOMMENDED_ACTION_LABELS: Readonly<Record<RecommendedAction, string>> = Object.freeze({
  CHASE_VENDOR: "Chase vendor",
  HOLD_PAYMENT: "Hold payment",
  RELEASE_PAYMENT: "Release payment",
  REVERSE_CREDIT: "Reverse credit",
  CLAIM_NOW: "Claim now",
  CORRECT_BOOKS: "Correct books",
  VERIFY_VENDOR: "Verify vendor",
});

export function recommendedActionLabel(action: RecommendedAction): string {
  return RECOMMENDED_ACTION_LABELS[action] ?? action;
}

// ---------------------------------------------------------------------------
// Match tiers
// ---------------------------------------------------------------------------

export const MATCH_TIER_LABELS: Readonly<Record<MatchTier, string>> = Object.freeze({
  EXACT: "Exact",
  TOLERANT: "Within tolerance",
  MISMATCH: "Value mismatch",
  FUZZY: "Probable — needs review",
  BOOKS_ONLY: "In books, not in 2B",
  GSTR2B_ONLY: "In 2B, not in books",
});

/** Display order for tier breakdowns: strongest evidence first. */
export const MATCH_TIER_ORDER: readonly MatchTier[] = Object.freeze([
  "EXACT",
  "TOLERANT",
  "MISMATCH",
  "FUZZY",
  "BOOKS_ONLY",
  "GSTR2B_ONLY",
] as const);

export function matchTierLabel(tier: MatchTier): string {
  return MATCH_TIER_LABELS[tier] ?? tier;
}

// ---------------------------------------------------------------------------
// Vendor and decision vocabulary
// ---------------------------------------------------------------------------

export const RISK_BAND_LABELS: Readonly<Record<VendorProfile["riskBand"], string>> = Object.freeze({
  SAFE: "Safe",
  WATCH: "Watch",
  HIGH: "High risk",
  SEVERE: "Severe",
});

export const MSME_LABELS: Readonly<Record<MsmeStatus, string>> = Object.freeze({
  MICRO: "Micro",
  SMALL: "Small",
  MEDIUM: "Medium",
  NOT_MSME: "Not MSME",
  UNKNOWN: "Unknown",
});

export const VERDICT_LABELS: Readonly<Record<PayHoldDecision["verdict"], string>> = Object.freeze({
  PAY: "Pay in full",
  HOLD: "Hold payment",
  PAY_NET_OF_GST: "Pay net of GST",
  ESCALATE: "Escalate — needs a human decision",
});

/**
 * Label for a pay/hold binding constraint. "NONE" is a real, meaningful
 * answer — it means nothing forced the verdict, which is itself reassuring.
 */
export function bindingConstraintLabel(constraint: PayHoldDecision["bindingConstraint"]): string {
  return constraint === "NONE" ? "No binding constraint" : riskRuleLabel(constraint);
}

export function bindingConstraintCitation(constraint: PayHoldDecision["bindingConstraint"]): string {
  return constraint === "NONE" ? "" : riskRuleCitation(constraint);
}

// ---------------------------------------------------------------------------
// Misc display
// ---------------------------------------------------------------------------

export function yesNo(value: boolean): string {
  return value ? "Yes" : "No";
}

/** The two words the CA looks for first. Never soften either of them. */
export function balancedLabel(balanced: boolean): string {
  return balanced ? "BALANCED" : "NOT BALANCED";
}
