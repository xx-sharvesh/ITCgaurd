/**
 * Run orchestration: match → price → score → tie out.
 *
 * The control totals computed here are the product's credibility. A CA opens
 * the report, looks at the footer, and checks that our numbers reconcile to
 * the two files they gave us. If they tie, everything else gets read. If they
 * don't, nothing else gets read — so when they don't tie we say so on the face
 * of the report rather than rendering a confident number over a broken sum.
 */

import type {
  ControlTotals,
  GSTR2BRecord,
  ISODate,
  MatchResult,
  Paise,
  PurchaseRecord,
  ReconciliationRun,
  RiskFinding,
  RiskRuleId,
  VendorPeriodSnapshot,
  VendorProfile,
  VendorTrend,
} from "../domain/types";
import { totalTax } from "../domain/money";
import { validateGstin } from "../domain/gstin";
import { periodOf } from "../domain/normalize";
import { autoResolvedRatio, reconcile } from "./match";
import { evaluateRules, type RuleContext } from "./rules";
import { decidePayHold, type DecisionContext } from "./decide";
import type { MatchConfig, StatutoryConfig } from "./config";

export interface RunOptions {
  /** Reference date for every statutory clock. Never defaults to now(). */
  asOf: ISODate;
  /** Period under reconciliation, `MMYYYY`. Inferred from the data if omitted. */
  period?: string;
  match?: MatchConfig;
  statutory?: StatutoryConfig;
  msmeWrittenAgreement?: boolean;
  /** Deterministic run id, for reproducible tests and stable exports. */
  runId?: string;
  /**
   * This vendor's scored history from prior periods, keyed by GSTIN, each
   * list ascending by period. Optional and additive: omitted entirely, every
   * vendor is scored exactly as if this feature did not exist — trend comes
   * back "NEW" and the loss-probability estimate uses this run alone, the
   * same numbers this engine has always produced. Supplied, it sharpens the
   * pay/hold estimate with a track record instead of one month's snapshot.
   */
  vendorHistory?: Record<string, VendorPeriodSnapshot[]>;
}

export function runReconciliation(
  purchases: PurchaseRecord[],
  gstr2b: GSTR2BRecord[],
  options: RunOptions,
): ReconciliationRun {
  const matches = reconcile(purchases, gstr2b, { config: options.match });

  const ruleCtx: RuleContext = {
    asOf: options.asOf,
    statutory: options.statutory,
    msmeWrittenAgreement: options.msmeWrittenAgreement,
  };

  const decisionCtx: DecisionContext = { ...ruleCtx, vendorHistory: options.vendorHistory };

  const findings = evaluateRules(matches, ruleCtx);
  const decisions = decidePayHold(matches, findings, decisionCtx);
  const vendors = buildVendorProfiles(matches, findings, options.vendorHistory);
  const totals = computeControlTotals(purchases, gstr2b, matches);

  // Headline exposure. Deliberately excludes IN_2B_NOT_IN_BOOKS: that is
  // credit being *left behind*, not credit at risk of being lost, and folding
  // the two together would inflate the number the CFO quotes to their board.
  const totalAtRisk = findings
    .filter((f) => f.rule !== "IN_2B_NOT_IN_BOOKS")
    .reduce((sum, f) => sum + f.amountAtRisk, 0);

  return {
    id: options.runId ?? `run-${options.asOf}-${purchases.length}-${gstr2b.length}`,
    createdAt: `${options.asOf}T00:00:00.000Z`,
    period: options.period ?? inferPeriod(purchases, gstr2b),
    matches,
    findings,
    vendors,
    decisions,
    totals,
    totalAtRisk,
    autoResolvedRatio: autoResolvedRatio(matches),
  };
}

/** Credit the books are *claiming* that is unclaimable — the opposite view. */
export function unclaimedOpportunity(findings: RiskFinding[]): Paise {
  return findings
    .filter((f) => f.rule === "IN_2B_NOT_IN_BOOKS")
    .reduce((sum, f) => sum + f.amountAtRisk, 0);
}

// ---------------------------------------------------------------------------
// Control totals
// ---------------------------------------------------------------------------

function computeControlTotals(
  purchases: PurchaseRecord[],
  gstr2b: GSTR2BRecord[],
  matches: MatchResult[],
): ControlTotals {
  const booksItc = purchases.reduce((s, p) => s + totalTax(p.tax), 0);
  const gstr2bItc = gstr2b.reduce((s, g) => s + totalTax(g.tax), 0);

  // Books-side value of every line that found a counterpart.
  const matchedItc = matches
    .filter((m) => m.purchase && m.gstr2b)
    .reduce((s, m) => s + totalTax(m.purchase!.tax), 0);

  const booksOnlyItc = matches
    .filter((m) => m.tier === "BOOKS_ONLY" && m.purchase)
    .reduce((s, m) => s + totalTax(m.purchase!.tax), 0);

  const gstr2bOnlyItc = matches
    .filter((m) => m.tier === "GSTR2B_ONLY" && m.gstr2b)
    .reduce((s, m) => s + totalTax(m.gstr2b!.tax), 0);

  // Money-conservation check. Every rupee of books credit must be either
  // matched or unmatched — there is no third place for it to go. If this
  // fails, the engine has lost or duplicated a line and the run is not safe
  // to act on.
  const booksSide = matchedItc + booksOnlyItc;
  const balanced = booksSide === booksItc;

  return {
    booksLineCount: purchases.length,
    gstr2bLineCount: gstr2b.length,
    booksItc,
    gstr2bItc,
    matchedItc,
    booksOnlyItc,
    gstr2bOnlyItc,
    balanced,
    imbalanceNote: balanced
      ? undefined
      : `Books ITC of ${booksItc} paise does not equal matched (${matchedItc}) plus unmatched (${booksOnlyItc}); ` +
        `difference of ${booksItc - booksSide} paise. This run should not be relied on until the discrepancy is resolved.`,
  };
}

// ---------------------------------------------------------------------------
// Vendor scoring
// ---------------------------------------------------------------------------

/**
 * Risk score, 0 (clean) to 100 (severe).
 *
 * Weighted toward what actually costs money rather than what merely looks
 * untidy: failing to appear in 2B at all, and declaring invoices without
 * paying the tax. A vendor with a handful of paise-level value mismatches is
 * not a risk, and scoring them as one would train users to ignore the score.
 *
 * `vendorHistory` is deliberately optional and additive: the score itself is
 * always computed from this run's data alone, exactly as before history
 * existed, so a caller with no history gets byte-identical numbers. History
 * only ever adds new descriptive fields (trend, streak) on top — it never
 * reaches back and changes what "this month" means.
 */
function buildVendorProfiles(
  matches: MatchResult[],
  findings: RiskFinding[],
  vendorHistory: Record<string, VendorPeriodSnapshot[]> = {},
): VendorProfile[] {
  interface Acc {
    gstin: string;
    name: string;
    exposure: Paise;
    atRisk: Paise;
    invoiceCount: number;
    missingFrom2b: number;
    booksLines: number;
    periods: Set<string>;
    missedPeriods: Set<string>;
    rules: Set<RiskRuleId>;
    msme: VendorProfile["msmeStatus"];
  }

  const acc = new Map<string, Acc>();

  for (const m of matches) {
    const rec = m.purchase ?? m.gstr2b;
    if (!rec) continue;

    let a = acc.get(rec.supplierGstin);
    if (!a) {
      a = {
        gstin: rec.supplierGstin,
        name: rec.supplierName,
        exposure: 0,
        atRisk: 0,
        invoiceCount: 0,
        missingFrom2b: 0,
        booksLines: 0,
        periods: new Set(),
        missedPeriods: new Set(),
        rules: new Set(),
        msme: "UNKNOWN",
      };
      acc.set(rec.supplierGstin, a);
    }

    a.invoiceCount += 1;
    a.periods.add(periodOf(rec.invoiceDate));

    if (m.purchase) {
      a.booksLines += 1;
      a.exposure += totalTax(m.purchase.tax);
      if (m.purchase.msmeStatus && m.purchase.msmeStatus !== "UNKNOWN") {
        a.msme = m.purchase.msmeStatus;
      }
      if (m.tier === "BOOKS_ONLY") {
        a.missingFrom2b += 1;
        a.missedPeriods.add(periodOf(m.purchase.invoiceDate));
      }
    }
  }

  for (const f of findings) {
    const a = acc.get(f.supplierGstin);
    if (!a) continue;
    a.rules.add(f.rule);
    // Unclaimed credit is not this vendor's fault and must not inflate their
    // risk score — the failure there is ours, not theirs.
    if (f.rule !== "IN_2B_NOT_IN_BOOKS") {
      a.atRisk += f.amountAtRisk;
    }
  }

  const profiles: VendorProfile[] = [];

  for (const a of acc.values()) {
    const validation = validateGstin(a.gstin);
    const missRate = a.booksLines > 0 ? a.missingFrom2b / a.booksLines : 0;

    let score = 0;
    score += missRate * 55;
    if (a.rules.has("RULE_37A_SUPPLIER_3B_UNFILED")) score += 25;
    if (a.rules.has("SEC_16_4_TIME_BARRED")) score += 10;
    if (a.rules.has("ITC_MARKED_INELIGIBLE")) score += 6;
    if (a.rules.has("VALUE_MISMATCH")) score += 4;
    if (!validation.valid) score += 8;

    // Concentration: a vendor carrying a large share of at-risk credit is
    // riskier to the business than the same behaviour on a small account.
    if (a.exposure > 0) {
      score += Math.min(12, (a.atRisk / a.exposure) * 12);
    }

    const riskScore = Math.round(Math.min(100, score));

    const prior = vendorHistory[a.gstin] ?? [];
    const history = summarizeHistory(prior, riskScore, a.atRisk > 0);

    profiles.push({
      gstin: a.gstin,
      name: a.name,
      gstinValid: validation.valid,
      msmeStatus: a.msme,
      itcExposure: a.exposure,
      itcAtRisk: a.atRisk,
      riskScore,
      riskBand: bandFor(riskScore),
      missedFilings: a.missedPeriods.size,
      observedPeriods: a.periods.size,
      invoiceCount: a.invoiceCount,
      findings: [...a.rules],
      booksLineCount: a.booksLines,
      missingFrom2bCount: a.missingFrom2b,
      trend: history.trend,
      trendDeltaScore: history.trendDeltaScore,
      consecutiveFlaggedPeriods: history.consecutiveFlaggedPeriods,
      historicalMissRate: history.historicalMissRate,
      periodsOfHistory: history.periodsOfHistory,
    });
  }

  profiles.sort((a, b) => b.itcAtRisk - a.itcAtRisk || b.riskScore - a.riskScore);
  return profiles;
}

interface HistorySummary {
  trend: VendorTrend;
  trendDeltaScore: number | null;
  consecutiveFlaggedPeriods: number;
  historicalMissRate: number | null;
  periodsOfHistory: number;
}

/**
 * Turn a vendor's prior snapshots plus this period's outcome into the
 * descriptive fields shown next to the score: is this getting better or
 * worse, and how many periods running has it been bad.
 *
 * `prior` must already exclude the current period — this function only ever
 * looks backward from "now".
 */
function summarizeHistory(
  prior: VendorPeriodSnapshot[],
  currentRiskScore: number,
  currentlyFlagged: boolean,
): HistorySummary {
  if (prior.length === 0) {
    return {
      trend: "NEW",
      trendDeltaScore: null,
      consecutiveFlaggedPeriods: currentlyFlagged ? 1 : 0,
      historicalMissRate: null,
      periodsOfHistory: 0,
    };
  }

  const previous = prior[prior.length - 1];
  const trendDeltaScore = currentRiskScore - previous.riskScore;

  // A dead-band of 8 points keeps ordinary month-to-month noise from being
  // labelled a trend — only a real swing counts as improving or worsening.
  const trend: VendorTrend =
    trendDeltaScore > 8 ? "WORSENING" : trendDeltaScore < -8 ? "IMPROVING" : "STABLE";

  // Walk backward while every period stays flagged; stop at the first clean
  // one. A vendor not flagged this period has a streak of zero regardless of
  // history — the streak means "in a row, ending now".
  let consecutiveFlaggedPeriods = currentlyFlagged ? 1 : 0;
  if (currentlyFlagged) {
    for (let i = prior.length - 1; i >= 0; i--) {
      if (prior[i].itcAtRiskPaise > 0) consecutiveFlaggedPeriods += 1;
      else break;
    }
  }

  const withBooksLines = prior.filter((s) => s.booksLineCount > 0);
  const totalBooksLines = withBooksLines.reduce((s, x) => s + x.booksLineCount, 0);
  const totalMissing = withBooksLines.reduce((s, x) => s + x.missingFrom2bCount, 0);
  const historicalMissRate = totalBooksLines > 0 ? totalMissing / totalBooksLines : null;

  return {
    trend,
    trendDeltaScore,
    consecutiveFlaggedPeriods,
    historicalMissRate,
    periodsOfHistory: prior.length,
  };
}

/**
 * Compress this run's vendor scores into the small digest that gets persisted
 * as history for next time. The caller decides whether and where to store it
 * (see `lib/store/vendor-history.ts`) — this function stays a pure function of
 * the run, so it is testable without touching storage and safe to call from a
 * server-rendered demo that must never write to anyone's browser.
 */
export function snapshotVendors(run: ReconciliationRun): VendorPeriodSnapshot[] {
  const recordedAt = new Date().toISOString();
  return run.vendors.map((v) => ({
    gstin: v.gstin,
    name: v.name,
    period: run.period,
    riskScore: v.riskScore,
    riskBand: v.riskBand,
    itcExposurePaise: v.itcExposure,
    itcAtRiskPaise: v.itcAtRisk,
    booksLineCount: v.booksLineCount,
    missingFrom2bCount: v.missingFrom2bCount,
    hadRule37A: v.findings.includes("RULE_37A_SUPPLIER_3B_UNFILED"),
    recordedAt,
  }));
}

function bandFor(score: number): VendorProfile["riskBand"] {
  if (score >= 65) return "SEVERE";
  if (score >= 40) return "HIGH";
  if (score >= 15) return "WATCH";
  return "SAFE";
}

function inferPeriod(purchases: PurchaseRecord[], gstr2b: GSTR2BRecord[]): string {
  const first = gstr2b[0]?.period;
  if (first) return first;
  const date = purchases[0]?.invoiceDate ?? gstr2b[0]?.invoiceDate;
  return date ? periodOf(date) : "";
}
