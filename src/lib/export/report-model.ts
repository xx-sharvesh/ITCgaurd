/**
 * Data shaping for the printable one-page audit report.
 *
 * Pure data — no React, no JSX, no DOM. The UI owns rendering; this module
 * owns *what the numbers are and what they are called*, so the printed page,
 * the screen and the Excel working paper cannot disagree.
 *
 * Money convention at this boundary: every `*Raw` number is RUPEES (a real
 * decimal number suitable for a chart axis or a proportion bar), converted
 * from domain paise exactly once via `paiseToRupees`. Every other money field
 * is an already-formatted display string. No caller should ever need to divide
 * by 100 again.
 */

import { formatINR, formatINRCompact, paiseToRupees } from "@/lib/domain/money";
import { daysBetween, formatDate, formatPeriod } from "@/lib/domain/normalize";
import type {
  ControlTotals,
  ISODate,
  Paise,
  ReconciliationRun,
  RiskFinding,
  RiskRuleId,
  Severity,
} from "@/lib/domain/types";
import { isoDateOf, safeRatio } from "./format";
import {
  RISK_RULES,
  SEVERITY_RANK,
  compareSeverity,
  riskRuleCitation,
  riskRuleLabel,
  type ExportMeta,
} from "./labels";

// ---------------------------------------------------------------------------
// The model the printable report renders
// ---------------------------------------------------------------------------

export interface ReportModel {
  headline: { totalAtRisk: string; totalAtRiskCompact: string; period: string; generatedAt: string };
  kpis: { label: string; value: string; sub?: string; tone: "danger" | "warn" | "good" | "neutral" }[];
  riskBreakdown: {
    rule: string;
    citation: string;
    label: string;
    count: number;
    amount: string;
    /** RUPEES, not paise. For charts and sorting. */
    amountRaw: number;
    /** 0..1 share of the summed at-risk amount across all rules. */
    share: number;
  }[];
  topVendors: {
    name: string;
    gstin: string;
    atRisk: string;
    /** RUPEES, not paise. */
    atRiskRaw: number;
    band: string;
    reasons: string[];
  }[];
  /** Soonest first. `date` is display-formatted ("30 Nov 2027"). */
  deadlines: { date: string; label: string; amount: string; daysAway: number; urgent: boolean }[];
  controlTotals: { label: string; value: string }[];
  balanced: boolean;
  imbalanceNote?: string;
}

/** A deadline inside this many days is called out in red. */
const URGENT_DAYS = 30;

/** How many vendors the one-pager has room for. */
const TOP_VENDOR_LIMIT = 10;

const COUNT_FORMAT = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

// ---------------------------------------------------------------------------
// Shared aggregation — also consumed by workbook.ts so the Summary sheet and
// the printed page are literally the same numbers.
// ---------------------------------------------------------------------------

export interface RuleAggregate {
  rule: RiskRuleId;
  label: string;
  citation: string;
  /** Most severe severity observed among the findings for this rule. */
  severity: Severity;
  count: number;
  /** Integer paise. */
  amountPaise: Paise;
}

/**
 * Group findings by statutory rule, most money first.
 *
 * Amounts are summed in integer paise, so the total is exact — this is a
 * re-presentation of the engine's own numbers, never a re-derivation.
 */
export function aggregateFindingsByRule(findings: readonly RiskFinding[]): RuleAggregate[] {
  const byRule = new Map<RiskRuleId, { count: number; amountPaise: Paise; severity: Severity; citations: Set<string> }>();

  for (const f of findings) {
    const existing = byRule.get(f.rule);
    if (existing) {
      existing.count += 1;
      existing.amountPaise += f.amountAtRisk;
      if (compareSeverity(f.severity, existing.severity) < 0) existing.severity = f.severity;
      if (f.citation) existing.citations.add(f.citation);
    } else {
      byRule.set(f.rule, {
        count: 1,
        amountPaise: f.amountAtRisk,
        severity: f.severity,
        citations: new Set(f.citation ? [f.citation] : []),
      });
    }
  }

  const rows: RuleAggregate[] = [];
  for (const [rule, agg] of byRule) {
    rows.push({
      rule,
      label: riskRuleLabel(rule),
      // Prefer the engine's own citation when every finding for this rule
      // agrees on it — the engine may cite a more specific sub-clause than our
      // rule-level table. Fall back to the table when they disagree, so the
      // summary never silently picks one finding's wording over another's.
      citation: agg.citations.size === 1 ? [...agg.citations][0] : riskRuleCitation(rule),
      severity: agg.severity,
      count: agg.count,
      amountPaise: agg.amountPaise,
    });
  }

  rows.sort((a, b) => {
    if (b.amountPaise !== a.amountPaise) return b.amountPaise - a.amountPaise;
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    return bySeverity !== 0 ? bySeverity : a.label.localeCompare(b.label);
  });

  return rows;
}

export interface TieBack {
  /** booksItc − matchedItc − booksOnlyItc, in integer paise. Nil when it ties. */
  differencePaise: Paise;
  /**
   * The engine's own verdict AND the arithmetic agreeing. If either says the
   * run does not tie, this is false — a working paper must fail loudly.
   */
  balanced: boolean;
  /** Populated whenever `balanced` is false. Never empty in that case. */
  note?: string;
}

/**
 * Re-check the control-total identity documented on `ControlTotals`:
 * booksItc = matchedItc (books side) + booksOnlyItc.
 *
 * This is integer paise subtraction — no division, no floats, so it introduces
 * no rounding of its own and cannot manufacture a false break. We surface it
 * rather than trusting `totals.balanced` alone because the flag and the numbers
 * are produced by different code paths, and the CA is entitled to see the
 * arithmetic that supports the word "BALANCED".
 */
export function tieBack(totals: ControlTotals): TieBack {
  const differencePaise = totals.booksItc - totals.matchedItc - totals.booksOnlyItc;
  const arithmeticTies = differencePaise === 0;
  const balanced = totals.balanced && arithmeticTies;

  if (balanced) return { differencePaise, balanced };

  let note: string;
  if (!totals.balanced && totals.imbalanceNote) {
    note = totals.imbalanceNote;
  } else if (!totals.balanced) {
    note = `The reconciliation engine reported this run as NOT BALANCED. Books ITC less matched ITC less books-only ITC leaves ${formatINR(differencePaise)} unaccounted for.`;
  } else {
    // The flag says balanced but the numbers do not add up. This is the case
    // that must never be swallowed: it means our own totals disagree.
    note = `Control totals do not tie: books ITC less matched ITC less books-only ITC leaves ${formatINR(differencePaise)}, which should be nil. Do not rely on these figures until the source files are re-checked.`;
  }

  return { differencePaise, balanced, note };
}

/** Report date: the caller's stamp, falling back to when the run was created. */
export function asOfDate(run: ReconciliationRun, meta: ExportMeta): ISODate {
  return isoDateOf(meta.generatedAt) || isoDateOf(run.createdAt) || "";
}

/** Whole days from `asOf` to `target`. Null when either date is unusable. */
export function daysUntil(asOf: ISODate, target: ISODate | undefined): number | null {
  if (!asOf || !target) return null;
  const d = daysBetween(asOf, target);
  return Number.isFinite(d) ? d : null;
}

// ---------------------------------------------------------------------------
// buildReportModel
// ---------------------------------------------------------------------------

export function buildReportModel(run: ReconciliationRun, meta: ExportMeta): ReportModel {
  const totals = run.totals;
  const asOf = asOfDate(run, meta);
  const tie = tieBack(totals);

  const ruleRows = aggregateFindingsByRule(run.findings);
  // Denominator for the proportion bar is the summed rule amounts, not
  // run.totalAtRisk. Rules overlap — one invoice can breach Rule 37 and
  // Sec 43B(h) at once — so shares against the headline could exceed 100%.
  const ruleTotalPaise = ruleRows.reduce((sum, r) => sum + r.amountPaise, 0);

  return {
    headline: {
      totalAtRisk: formatINR(run.totalAtRisk),
      totalAtRiskCompact: formatINRCompact(run.totalAtRisk),
      // run.period is the period the data actually covers and wins over
      // meta.period, which is only what the operator typed on the export form.
      period: formatPeriod(run.period),
      generatedAt: asOf ? formatDate(asOf) : "",
    },
    kpis: buildKpis(run),
    riskBreakdown: ruleRows.map((r) => ({
      rule: r.rule,
      citation: r.citation,
      label: r.label,
      count: r.count,
      amount: formatINR(r.amountPaise),
      amountRaw: paiseToRupees(r.amountPaise),
      share: safeRatio(r.amountPaise, ruleTotalPaise),
    })),
    topVendors: buildTopVendors(run),
    deadlines: buildDeadlines(run.findings, asOf),
    controlTotals: buildControlTotalRows(totals, tie),
    balanced: tie.balanced,
    ...(tie.note ? { imbalanceNote: tie.note } : {}),
  };
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function buildKpis(run: ReconciliationRun): ReportModel["kpis"] {
  const t = run.totals;
  const vendorsAtRisk = run.vendors.filter((v) => v.itcAtRisk > 0).length;
  const matchedLines = run.matches.filter(
    (m) => m.tier === "EXACT" || m.tier === "TOLERANT" || m.tier === "MISMATCH" || m.tier === "FUZZY",
  ).length;
  const booksOnlyLines = run.matches.filter((m) => m.tier === "BOOKS_ONLY").length;
  const gstr2bOnlyLines = run.matches.filter((m) => m.tier === "GSTR2B_ONLY").length;
  const holdExposure = run.decisions
    .filter((d) => d.verdict === "HOLD" || d.verdict === "PAY_NET_OF_GST")
    .reduce((sum, d) => sum + d.exposure, 0);

  const kpis: ReportModel["kpis"] = [
    {
      label: "Total ITC at risk",
      value: formatINR(run.totalAtRisk),
      sub: `${count(run.findings.length)} finding${run.findings.length === 1 ? "" : "s"} across ${count(vendorsAtRisk)} vendor${vendorsAtRisk === 1 ? "" : "s"}`,
      tone: run.totalAtRisk > 0 ? "danger" : "good",
    },
    {
      label: "ITC claimed in books",
      value: formatINR(t.booksItc),
      sub: `${count(t.booksLineCount)} purchase lines`,
      tone: "neutral",
    },
    {
      label: "ITC available in GSTR-2B",
      value: formatINR(t.gstr2bItc),
      sub: `${count(t.gstr2bLineCount)} portal documents`,
      tone: "neutral",
    },
    {
      label: "Matched",
      value: formatINR(t.matchedItc),
      sub: `${count(matchedLines)} of ${count(run.matches.length)} lines tied to a 2B document`,
      tone: "good",
    },
    {
      label: "Claimed but not in 2B",
      value: formatINR(t.booksOnlyItc),
      sub: `${count(booksOnlyLines)} lines with no portal support`,
      tone: t.booksOnlyItc > 0 ? "danger" : "good",
    },
    {
      label: "In 2B but not booked",
      value: formatINR(t.gstr2bOnlyItc),
      // Framed as money owed to the client, because that is what it is.
      sub: `${count(gstr2bOnlyLines)} documents — credit you may be entitled to`,
      tone: t.gstr2bOnlyItc > 0 ? "warn" : "neutral",
    },
    {
      label: "Auto-resolved",
      value: percent(run.autoResolvedRatio),
      sub: "lines cleared without manual review",
      tone: run.autoResolvedRatio >= 0.9 ? "good" : run.autoResolvedRatio >= 0.7 ? "warn" : "danger",
    },
  ];

  if (run.decisions.length > 0) {
    kpis.push({
      label: "Payments to hold",
      value: formatINR(holdExposure),
      sub: `${count(run.decisions.length)} vendor payment decision${run.decisions.length === 1 ? "" : "s"} pending`,
      tone: holdExposure > 0 ? "warn" : "good",
    });
  }

  return kpis;
}

function buildTopVendors(run: ReconciliationRun): ReportModel["topVendors"] {
  return run.vendors
    .filter((v) => v.itcAtRisk > 0)
    .slice()
    .sort((a, b) => b.itcAtRisk - a.itcAtRisk || b.riskScore - a.riskScore)
    .slice(0, TOP_VENDOR_LIMIT)
    .map((v) => {
      // Reasons read as a sentence fragment a CFO can act on, not enum names.
      const reasons: string[] = [];
      if (!v.gstinValid) reasons.push("GSTIN fails validation");
      for (const rule of v.findings) {
        const label = riskRuleLabel(rule);
        if (!reasons.includes(label)) reasons.push(label);
      }
      if (v.missedFilings > 0 && v.observedPeriods > 0) {
        reasons.push(`Missed ${count(v.missedFilings)} of ${count(v.observedPeriods)} filings`);
      }

      return {
        name: v.name,
        gstin: v.gstin,
        atRisk: formatINR(v.itcAtRisk),
        atRiskRaw: paiseToRupees(v.itcAtRisk),
        band: v.riskBand,
        reasons,
      };
    });
}

/**
 * Deadlines, grouped by (date, rule) so a page does not list forty rows that
 * all say "30 Nov 2027 — claim window closing".
 *
 * Only RiskFinding deadlines appear here. Pay/hold `decideBy` dates are a
 * different quantity (exposure being decided, not credit being lost) and mixing
 * them into one money column would make the column meaningless. They live on
 * the Pay-Hold Decisions sheet of the workbook.
 */
function buildDeadlines(findings: readonly RiskFinding[], asOf: ISODate): ReportModel["deadlines"] {
  const groups = new Map<string, { date: ISODate; label: string; amountPaise: Paise }>();

  for (const f of findings) {
    if (!f.deadline) continue;
    const key = `${f.deadline}|${f.rule}`;
    const existing = groups.get(key);
    if (existing) {
      existing.amountPaise += f.amountAtRisk;
    } else {
      groups.set(key, {
        date: f.deadline,
        label: riskRuleLabel(f.rule),
        amountPaise: f.amountAtRisk,
      });
    }
  }

  return [...groups.values()]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.label.localeCompare(b.label)))
    .map((g) => {
      const daysAway = daysUntil(asOf, g.date);
      return {
        date: formatDate(g.date),
        label: g.label,
        amount: formatINR(g.amountPaise),
        daysAway: daysAway ?? 0,
        // Already past due counts as urgent — a negative number of days is the
        // most urgent case there is, not a comfortable one.
        urgent: daysAway === null ? false : daysAway <= URGENT_DAYS,
      };
    });
}

function buildControlTotalRows(totals: ControlTotals, tie: TieBack): ReportModel["controlTotals"] {
  return [
    { label: "Purchase register lines", value: count(totals.booksLineCount) },
    { label: "GSTR-2B documents", value: count(totals.gstr2bLineCount) },
    { label: "ITC per books", value: formatINR(totals.booksItc) },
    { label: "ITC per GSTR-2B", value: formatINR(totals.gstr2bItc) },
    { label: "Matched ITC", value: formatINR(totals.matchedItc) },
    { label: "Books only", value: formatINR(totals.booksOnlyItc) },
    { label: "GSTR-2B only", value: formatINR(totals.gstr2bOnlyItc) },
    { label: "Tie-back difference (must be nil)", value: formatINR(tie.differencePaise) },
  ];
}

// ---------------------------------------------------------------------------
// Small formatters
// ---------------------------------------------------------------------------

function count(n: number): string {
  return COUNT_FORMAT.format(n);
}

function percent(ratio: number): string {
  if (!Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(1)}%`;
}

/** Re-exported so the UI can render a rule legend without importing labels. */
export { RISK_RULES };
