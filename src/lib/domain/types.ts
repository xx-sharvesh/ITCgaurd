/**
 * Core domain contract for ITC Guard.
 *
 * MONEY RULE (non-negotiable): every monetary value in this system is an
 * integer number of paise. Never a float, never a string, never rupees.
 * Rupees exist only at the formatting boundary (see money.ts). A float rupee
 * value that survives into the engine is a bug that silently loses money.
 */

/** Integer paise. 100 paise = 1 rupee. */
export type Paise = number;

/** ISO date string, `YYYY-MM-DD`. Timezone-free — GST dates are calendar dates. */
export type ISODate = string;

/** GST return period, `MMYYYY` as the portal emits it (e.g. "072026" = Jul 2026). */
export type Period = string;

/** Indian financial year label, e.g. "2026-27". */
export type FinancialYear = string;

// ---------------------------------------------------------------------------
// Tax
// ---------------------------------------------------------------------------

/**
 * The four-way GST split. Intra-state splits into CGST+SGST, inter-state is
 * IGST. Cess applies to demerit goods. All in paise.
 */
export interface TaxAmounts {
  igst: Paise;
  cgst: Paise;
  sgst: Paise;
  cess: Paise;
}

/** Total recoverable credit across all four heads. */
export interface TaxableLine {
  taxableValue: Paise;
  tax: TaxAmounts;
}

export type SupplyType = "B2B" | "B2BA" | "CDNR" | "CDNRA" | "ISD" | "IMPG" | "IMPS";

/** Document kind. Credit notes reduce ITC, debit notes increase it. */
export type DocumentType = "INVOICE" | "CREDIT_NOTE" | "DEBIT_NOTE";

// ---------------------------------------------------------------------------
// Source records
// ---------------------------------------------------------------------------

/**
 * One line from the taxpayer's own purchase register (books).
 * This is what they believe they are entitled to claim.
 */
export interface PurchaseRecord {
  /** Stable id we assign at parse time; not from the source file. */
  id: string;
  supplierGstin: string;
  supplierName: string;
  invoiceNumber: string;
  invoiceDate: ISODate;
  documentType: DocumentType;
  taxableValue: Paise;
  tax: TaxAmounts;
  /** Invoice value inclusive of tax, as stated in books. */
  invoiceValue: Paise;
  placeOfSupply?: string;
  /** True when the buyer pays tax under reverse charge — ITC path differs. */
  reverseCharge: boolean;
  /** Date the supplier was actually paid. Drives Rule 37 and Sec 43B(h). */
  paymentDate?: ISODate;
  /** Whether this vendor is a registered Micro/Small enterprise (Udyam). */
  msmeStatus?: MsmeStatus;
  /** Free-text row provenance for audit — original file row number. */
  sourceRow?: number;
}

/**
 * One line as reported by the supplier and surfaced to us in GSTR-2B.
 * This is what the government believes we are entitled to claim.
 */
export interface GSTR2BRecord {
  id: string;
  supplierGstin: string;
  supplierName: string;
  invoiceNumber: string;
  invoiceDate: ISODate;
  documentType: DocumentType;
  supplyType: SupplyType;
  taxableValue: Paise;
  tax: TaxAmounts;
  invoiceValue: Paise;
  placeOfSupply?: string;
  reverseCharge: boolean;
  /** Period this document landed in our 2B. */
  period: Period;
  /**
   * GSTN's own eligibility verdict. "No" means the portal is already telling
   * us this credit is not available — ignoring it is how people get notices.
   */
  itcAvailable: "Y" | "N";
  itcUnavailableReason?: string;
  /** Period in which the supplier filed the return carrying this document. */
  supplierFilingPeriod?: Period;
  /** Supplier's GSTR-3B filing status, when known. Drives Rule 37A. */
  supplierGstr3bFiled?: boolean;
  sourceRow?: number;
}

export type MsmeStatus = "MICRO" | "SMALL" | "MEDIUM" | "NOT_MSME" | "UNKNOWN";

/**
 * A vendor's beneficiary bank details, for routing an actual payment.
 *
 * Lives in the domain layer rather than under `lib/tally` because two
 * unrelated things need it — the Tally connector (which can harvest it from
 * a ledger master) and the payment-file export (which needs it regardless of
 * where it came from) — and neither should depend on the other just to share
 * a three-field shape.
 */
export interface BankDetails {
  accountNumber: string;
  ifsc: string;
  accountHolder?: string;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * How a books line and a 2B line were tied together.
 * Ordered by decreasing certainty — the engine must always prefer the
 * strongest available tier.
 */
export type MatchTier =
  /** GSTIN + canonical invoice no + date + every tax head identical. */
  | "EXACT"
  /** Same document, within documented rounding/date tolerance. */
  | "TOLERANT"
  /** Same document, but a field genuinely disagrees (value/rate/date). */
  | "MISMATCH"
  /** Probable pair below auto-accept confidence — needs a human. */
  | "FUZZY"
  /** In books, absent from 2B. */
  | "BOOKS_ONLY"
  /** In 2B, absent from books. */
  | "GSTR2B_ONLY";

/** Which fields disagree on a matched pair. Drives the "why" shown to the user. */
export interface FieldDelta {
  field: "taxableValue" | "igst" | "cgst" | "sgst" | "cess" | "invoiceDate" | "invoiceValue" | "placeOfSupply";
  /** Books value. */
  books: string | number;
  /** 2B value. */
  portal: string | number;
  /** Signed paise difference (books - portal) for monetary fields. */
  deltaPaise?: Paise;
}

export interface MatchResult {
  id: string;
  tier: MatchTier;
  purchase?: PurchaseRecord;
  gstr2b?: GSTR2BRecord;
  /** 0..1. EXACT is always 1. Auto-accept threshold lives in config. */
  confidence: number;
  /** Human-readable reasons the engine chose this tier. */
  reasons: string[];
  deltas: FieldDelta[];
  /** Net ITC difference this row represents, books minus portal. */
  itcDeltaPaise: Paise;
}

// ---------------------------------------------------------------------------
// Statutory risk
// ---------------------------------------------------------------------------

/**
 * Each rule maps to a specific provision. The citation is shown in the UI and
 * in the exported working papers — a CA must be able to verify our reasoning
 * against the bare Act, or they will not trust the number.
 */
export type RiskRuleId =
  /** Sec 16(2)(aa): credit only if the document appears in GSTR-2B. */
  | "SEC_16_2_AA_NOT_IN_2B"
  /** GSTN flagged the credit ineligible in 2B itself. */
  | "ITC_MARKED_INELIGIBLE"
  /** Rule 37: supplier unpaid beyond 180 days → reverse with interest. */
  | "RULE_37_180_DAY"
  /** Rule 37A: supplier filed GSTR-1 but not GSTR-3B → recipient reverses. */
  | "RULE_37A_SUPPLIER_3B_UNFILED"
  /** Sec 16(4): claim window closes 30 Nov of the following FY. */
  | "SEC_16_4_TIME_BARRED"
  /** Values disagree between books and 2B. */
  | "VALUE_MISMATCH"
  /** Claimed in books but the portal has no such document at all. */
  | "IN_2B_NOT_IN_BOOKS"
  /** Sec 43B(h) IT Act: MSME unpaid beyond limit → deduction disallowed. */
  | "SEC_43B_H_MSME_OVERDUE"
  /** Supplier GSTIN is cancelled/suspended or structurally invalid. */
  | "INVALID_OR_CANCELLED_GSTIN";

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export interface RiskFinding {
  id: string;
  rule: RiskRuleId;
  severity: Severity;
  /** Statutory citation, e.g. "Sec 16(2)(aa) CGST Act". */
  citation: string;
  /** One line a CFO understands without reading the Act. */
  headline: string;
  /** The precise mechanic, for the CA. */
  explanation: string;
  /** Rupees genuinely at stake on this finding. */
  amountAtRisk: Paise;
  /** Deadline after which the exposure crystallises, if the rule has one. */
  deadline?: ISODate;
  supplierGstin: string;
  supplierName: string;
  /** Matches this finding was derived from. */
  matchIds: string[];
  /** What the user should actually do. */
  recommendedAction: RecommendedAction;
}

export type RecommendedAction =
  | "CHASE_VENDOR"
  | "HOLD_PAYMENT"
  | "RELEASE_PAYMENT"
  | "REVERSE_CREDIT"
  | "CLAIM_NOW"
  | "CORRECT_BOOKS"
  | "VERIFY_VENDOR";

// ---------------------------------------------------------------------------
// The pay/hold decision — the differentiator
// ---------------------------------------------------------------------------

/**
 * The three-way squeeze. Paying a non-compliant vendor risks the GST credit;
 * holding an MSME vendor past the limit costs an income-tax deduction; holding
 * anyone past 180 days forces a credit reversal. The engine prices all three
 * and recommends the cheapest lawful path.
 */
export interface PayHoldDecision {
  supplierGstin: string;
  supplierName: string;
  /** Invoices under consideration. */
  matchIds: string[];
  /** Amount whose release is being decided. */
  exposure: Paise;
  verdict: "PAY" | "HOLD" | "PAY_NET_OF_GST" | "ESCALATE";
  /** Cost in paise of each branch, so the user can audit the recommendation. */
  costOfPaying: Paise;
  costOfHolding: Paise;
  /** Why the verdict won. */
  rationale: string[];
  /** Binding constraint that decided it. */
  bindingConstraint: RiskRuleId | "NONE";
  /** Latest date this decision can be deferred without a new cost appearing. */
  decideBy?: ISODate;
}

// ---------------------------------------------------------------------------
// Vendor
// ---------------------------------------------------------------------------

export interface VendorProfile {
  gstin: string;
  name: string;
  gstinValid: boolean;
  msmeStatus: MsmeStatus;
  /** Total ITC we are relying on this vendor to deliver, this run. */
  itcExposure: Paise;
  /** Of that, how much is currently at risk. */
  itcAtRisk: Paise;
  /** 0..100. Higher is worse. */
  riskScore: number;
  riskBand: "SAFE" | "WATCH" | "HIGH" | "SEVERE";
  /** Count of periods, of those observed, where the vendor filed late/not at all. */
  missedFilings: number;
  observedPeriods: number;
  invoiceCount: number;
  findings: RiskRuleId[];
  /** Invoices booked against this vendor this run — denominator for the miss rate. */
  booksLineCount: number;
  /** Of those, how many have no counterpart in GSTR-2B this run. */
  missingFrom2bCount: number;
  /**
   * How this vendor's score has moved since the last period we have on file.
   * "NEW" when no prior period exists — the honest answer when there is
   * nothing yet to compare against, never a silently-assumed STABLE.
   */
  trend: VendorTrend;
  /** riskScore minus the previous recorded period's riskScore. Null iff trend is NEW. */
  trendDeltaScore: number | null;
  /** Periods in a row, ending with this one, this vendor has carried genuine credit at risk. */
  consecutiveFlaggedPeriods: number;
  /** Share of invoices absent from 2B, averaged across all prior recorded periods. Null with no history. */
  historicalMissRate: number | null;
  /** How many prior periods contributed to trend and historicalMissRate. */
  periodsOfHistory: number;
}

export type VendorTrend = "NEW" | "IMPROVING" | "STABLE" | "WORSENING";

/**
 * A vendor's scored history, one entry per period it has been reconciled.
 * Deliberately a small digest — this is what gives the risk score memory
 * across months without needing a database: cheap enough to keep in
 * localStorage indefinitely, because it is not the register itself, just what
 * the register implied about this vendor that month.
 */
export interface VendorPeriodSnapshot {
  gstin: string;
  name: string;
  period: Period;
  riskScore: number;
  riskBand: VendorProfile["riskBand"];
  itcExposurePaise: Paise;
  itcAtRiskPaise: Paise;
  booksLineCount: number;
  missingFrom2bCount: number;
  hadRule37A: boolean;
  /** When this snapshot was recorded — ISO timestamp, not the period itself. */
  recordedAt: string;
}

// ---------------------------------------------------------------------------
// Run output
// ---------------------------------------------------------------------------

/**
 * Control totals. Every report footer shows these so a CA can tie our output
 * back to the source files in ten seconds. If these don't balance, we have a
 * bug and we must say so rather than render a number.
 */
export interface ControlTotals {
  booksLineCount: number;
  gstr2bLineCount: number;
  booksItc: Paise;
  gstr2bItc: Paise;
  matchedItc: Paise;
  booksOnlyItc: Paise;
  gstr2bOnlyItc: Paise;
  /** booksItc must equal matchedItc(books side) + booksOnlyItc. */
  balanced: boolean;
  /** Populated when balanced is false — never hidden from the user. */
  imbalanceNote?: string;
}

export interface ReconciliationRun {
  id: string;
  createdAt: string;
  period: Period;
  matches: MatchResult[];
  findings: RiskFinding[];
  vendors: VendorProfile[];
  decisions: PayHoldDecision[];
  totals: ControlTotals;
  /** Aggregate headline number: total rupees at risk. */
  totalAtRisk: Paise;
  /** Share of lines the engine resolved without human review, 0..1. */
  autoResolvedRatio: number;
}
