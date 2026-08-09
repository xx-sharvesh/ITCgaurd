"use client";

/**
 * The Close Cockpit.
 *
 * The design constraint that shapes this screen: a reconciliation tool that
 * hands back four thousand mismatches has created work, not removed it. So
 * nothing here is a list of exceptions. Findings are grouped into at most nine
 * action cards, ranked by rupees, each one a decision rather than an
 * observation, and each expandable to the vendors underneath only when the
 * user asks.
 *
 * The headline figure is deliberately enormous. It is the number the CFO came
 * for, the number they will repeat to their board, and the number that decides
 * whether they read the rest.
 */

import { useMemo, useState } from "react";
import {
  ChevronDown,
  Download,
  FileSpreadsheet,
  Landmark,
  ShieldAlert,
  TrendingUp,
} from "lucide-react";
import type { ReconciliationRun, RiskFinding, RiskRuleId } from "@/lib/domain/types";
import { formatINR, formatINRCompact } from "@/lib/domain/money";
import { formatDate, formatPeriod } from "@/lib/domain/normalize";
import { RISK_RULES, SEVERITY_LABELS, recommendedActionLabel } from "@/lib/export/labels";
import { unclaimedOpportunity } from "@/lib/engine/run";
import { Badge, Bar, Button, Card, Citation, EmptyState, Money, cx, type Tone } from "./primitives";

const SEVERITY_TONE = {
  CRITICAL: "danger",
  HIGH: "danger",
  MEDIUM: "warn",
  LOW: "info",
} as const satisfies Record<string, Tone>;

interface RuleGroup {
  rule: RiskRuleId;
  findings: RiskFinding[];
  amount: number;
  severity: RiskFinding["severity"];
  /** Soonest deadline across the group, if the rule carries one. */
  nextDeadline?: string;
}

function groupByRule(findings: RiskFinding[]): RuleGroup[] {
  const map = new Map<RiskRuleId, RuleGroup>();

  for (const f of findings) {
    let g = map.get(f.rule);
    if (!g) {
      g = { rule: f.rule, findings: [], amount: 0, severity: f.severity };
      map.set(f.rule, g);
    }
    g.findings.push(f);
    g.amount += f.amountAtRisk;
    if (rank(f.severity) < rank(g.severity)) g.severity = f.severity;
    if (f.deadline && (!g.nextDeadline || f.deadline < g.nextDeadline)) g.nextDeadline = f.deadline;
  }

  return [...map.values()].sort((a, b) => b.amount - a.amount);
}

function rank(s: RiskFinding["severity"]): number {
  return { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }[s];
}

export function Cockpit({
  run,
  asOf,
  onOpenVendor,
  onExport,
}: {
  run: ReconciliationRun;
  asOf: string;
  onOpenVendor: (gstin: string) => void;
  onExport: () => void;
}) {
  const groups = useMemo(() => groupByRule(run.findings), [run.findings]);

  // Unclaimed credit is shown separately and never folded into the headline.
  // It is money being left behind, not money at risk of being lost, and
  // combining the two would inflate the figure the CFO quotes upward.
  const opportunity = useMemo(() => unclaimedOpportunity(run.findings), [run.findings]);

  const atRiskGroups = groups.filter((g) => g.rule !== "IN_2B_NOT_IN_BOOKS");
  const opportunityGroup = groups.find((g) => g.rule === "IN_2B_NOT_IN_BOOKS");

  const exposureBase = run.totals.booksItc || 1;
  const riskShare = run.totalAtRisk / exposureBase;

  return (
    <div className="space-y-8">
      <Hero
        run={run}
        asOf={asOf}
        opportunity={opportunity}
        riskShare={riskShare}
        onExport={onExport}
      />

      <section>
        <div className="mb-4 flex items-baseline justify-between gap-4">
          <h2 className="text-[19px] font-semibold tracking-tight text-[var(--color-ink)]">
            What to do about it
          </h2>
          <span className="text-[12.5px] text-[var(--color-ink-muted)]">
            {atRiskGroups.length} action{atRiskGroups.length === 1 ? "" : "s"}, largest first
          </span>
        </div>

        {atRiskGroups.length === 0 ? (
          <Card>
            <EmptyState
              title="Nothing at risk this period"
              description="Every line in your register is matched, eligible, and inside its statutory clocks. Export the working papers for your file and close the month."
            />
          </Card>
        ) : (
          <div className="stagger space-y-3">
            {atRiskGroups.map((group) => (
              <ActionCard
                key={group.rule}
                group={group}
                asOf={asOf}
                totalAtRisk={run.totalAtRisk}
                onOpenVendor={onOpenVendor}
              />
            ))}
          </div>
        )}
      </section>

      {opportunityGroup && (
        <section>
          <div className="mb-4">
            <h2 className="text-[19px] font-semibold tracking-tight text-[var(--color-ink)]">
              Credit you are entitled to and not taking
            </h2>
            <p className="mt-1 text-[13.5px] text-[var(--color-ink-muted)]">
              These documents are in your GSTR-2B with the credit marked available, but there is no
              matching entry in your purchase register.
            </p>
          </div>
          <ActionCard
            group={opportunityGroup}
            asOf={asOf}
            totalAtRisk={opportunity}
            onOpenVendor={onOpenVendor}
            tone="good"
          />
        </section>
      )}

      <ControlTotalsPanel run={run} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function Hero({
  run,
  asOf,
  opportunity,
  riskShare,
  onExport,
}: {
  run: ReconciliationRun;
  asOf: string;
  opportunity: number;
  riskShare: number;
  onExport: () => void;
}) {
  const reviewNeeded = run.matches.filter((m) => m.tier === "FUZZY").length;

  return (
    <Card className="overflow-hidden">
      <div className="paper border-b border-[var(--color-line)] px-7 pb-8 pt-7">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-gold)]">
                Input tax credit at risk
              </span>
              <span className="h-px w-8 bg-[var(--color-gold-line)]" />
              <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--color-ink-muted)]">
                {formatPeriod(run.period)}
              </span>
            </div>

            <div className="display-figure mt-4 text-[clamp(2.75rem,7vw,4.5rem)] text-[var(--color-ink)]">
              {formatINRCompact(run.totalAtRisk)}
            </div>

            <div className="money mt-1 text-[13px] text-[var(--color-ink-muted)]">
              {formatINR(run.totalAtRisk)}
            </div>

            <p className="mt-4 max-w-xl text-[14px] leading-relaxed text-[var(--color-ink-soft)]">
              That is{" "}
              <strong className="font-semibold text-[var(--color-ink)]">
                {(riskShare * 100).toFixed(1)}%
              </strong>{" "}
              of the {formatINRCompact(run.totals.booksItc)} of credit your books are claiming this
              period, exposed across{" "}
              <strong className="font-semibold text-[var(--color-ink)]">
                {new Set(run.findings.map((f) => f.supplierGstin)).size} suppliers
              </strong>
              . Figures are as at {formatDate(asOf)}.
            </p>
          </div>

          <div className="flex shrink-0 gap-2">
            <Button icon={FileSpreadsheet} onClick={onExport}>
              Working papers
            </Button>
            <Button icon={Download} variant="primary" onClick={() => window.print()}>
              Print report
            </Button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 divide-x divide-[var(--color-line)] border-t border-[var(--color-line)] md:grid-cols-4">
        <HeroStat
          icon={Landmark}
          label="Credit claimed"
          value={formatINRCompact(run.totals.booksItc)}
          sub={`${run.totals.booksLineCount.toLocaleString("en-IN")} lines in the register`}
        />
        <HeroStat
          icon={TrendingUp}
          label="Unclaimed credit"
          value={formatINRCompact(opportunity)}
          sub="In your 2B, missing from books"
          tone="good"
        />
        <HeroStat
          icon={ShieldAlert}
          label="Auto-resolved"
          value={`${(run.autoResolvedRatio * 100).toFixed(1)}%`}
          sub={
            reviewNeeded === 0
              ? "No lines need a human"
              : `${reviewNeeded} line${reviewNeeded === 1 ? "" : "s"} need a human`
          }
        />
        <HeroStat
          icon={Landmark}
          label="Control totals"
          value={run.totals.balanced ? "Balanced" : "Not balanced"}
          sub={run.totals.balanced ? "Ties back to source files" : "Do not rely on this run"}
          tone={run.totals.balanced ? "good" : "danger"}
        />
      </div>
    </Card>
  );
}

function HeroStat({
  icon: Icon,
  label,
  value,
  sub,
  tone = "neutral",
}: {
  icon: typeof Landmark;
  label: string;
  value: string;
  sub: string;
  tone?: Tone;
}) {
  const toneClass = {
    danger: "text-[var(--color-danger)]",
    warn: "text-[var(--color-warn)]",
    good: "text-[var(--color-good)]",
    info: "text-[var(--color-info)]",
    neutral: "text-[var(--color-ink)]",
  }[tone];

  return (
    <div className="px-5 py-4">
      <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.11em] text-[var(--color-ink-muted)]">
        <Icon size={12} strokeWidth={2} aria-hidden />
        {label}
      </div>
      <div className={cx("money mt-1.5 text-[19px] font-semibold", toneClass)}>{value}</div>
      <div className="mt-0.5 text-[11.5px] leading-snug text-[var(--color-ink-muted)]">{sub}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ActionCard({
  group,
  asOf,
  totalAtRisk,
  onOpenVendor,
  tone: toneOverride,
}: {
  group: RuleGroup;
  asOf: string;
  totalAtRisk: number;
  onOpenVendor: (gstin: string) => void;
  tone?: Tone;
}) {
  const [open, setOpen] = useState(false);
  const meta = RISK_RULES[group.rule];
  const tone = toneOverride ?? SEVERITY_TONE[group.severity];

  // Roll the findings up per vendor: the user acts on a supplier, not on
  // eighteen individual invoices from that supplier.
  const byVendor = useMemo(() => {
    const map = new Map<string, { name: string; gstin: string; amount: number; count: number; deadline?: string }>();
    for (const f of group.findings) {
      const cur = map.get(f.supplierGstin) ?? {
        name: f.supplierName,
        gstin: f.supplierGstin,
        amount: 0,
        count: 0,
      };
      cur.amount += f.amountAtRisk;
      cur.count += 1;
      if (f.deadline && (!cur.deadline || f.deadline < cur.deadline)) cur.deadline = f.deadline;
      map.set(f.supplierGstin, cur);
    }
    return [...map.values()].sort((a, b) => b.amount - a.amount);
  }, [group.findings]);

  const share = totalAtRisk > 0 ? group.amount / totalAtRisk : 0;
  const daysToDeadline = group.nextDeadline ? daysBetweenISO(asOf, group.nextDeadline) : null;
  const action = group.findings[0]?.recommendedAction;

  return (
    <Card className="print-avoid-break overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-start gap-4 px-5 py-4 text-left transition-colors duration-150 hover:bg-[var(--color-surface-sunken)]"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={tone}>{SEVERITY_LABELS[group.severity]}</Badge>
            <h3 className="text-[15px] font-semibold text-[var(--color-ink)]">{meta.label}</h3>
            <Citation>{meta.citation}</Citation>
          </div>

          <p className="mt-2 max-w-3xl text-[13.5px] leading-relaxed text-[var(--color-ink-soft)]">
            {meta.plain}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[12.5px] text-[var(--color-ink-muted)]">
            <span>
              <strong className="font-semibold text-[var(--color-ink)]">{group.findings.length}</strong>{" "}
              document{group.findings.length === 1 ? "" : "s"}
            </span>
            <span>
              <strong className="font-semibold text-[var(--color-ink)]">{byVendor.length}</strong>{" "}
              supplier{byVendor.length === 1 ? "" : "s"}
            </span>
            {action && <span>Recommended: {recommendedActionLabel(action)}</span>}
            {daysToDeadline !== null && (
              <span className={daysToDeadline <= 30 ? "font-semibold text-[var(--color-danger)]" : undefined}>
                {daysToDeadline < 0
                  ? `Deadline passed ${Math.abs(daysToDeadline)} days ago`
                  : `${daysToDeadline} days to ${formatDate(group.nextDeadline!)}`}
              </span>
            )}
          </div>
        </div>

        <div className="shrink-0 text-right">
          <Money size="lg" tone={toneOverride === "good" ? "good" : tone}>
            {formatINRCompact(group.amount)}
          </Money>
          <div className="mt-1 text-[11px] text-[var(--color-ink-muted)]">
            {(share * 100).toFixed(0)}% of total
          </div>
          <div className="mt-2 w-24">
            <Bar share={share} tone={toneOverride === "good" ? "good" : tone} />
          </div>
        </div>

        <ChevronDown
          size={18}
          strokeWidth={2}
          aria-hidden
          className={cx(
            "mt-1 shrink-0 text-[var(--color-ink-faint)] transition-transform duration-200 ease-out",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="animate-fade border-t border-[var(--color-line)] bg-[var(--color-surface-sunken)]">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-[var(--color-line)] text-left text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[var(--color-ink-muted)]">
                <th className="px-5 py-2.5">Supplier</th>
                <th className="px-3 py-2.5">GSTIN</th>
                <th className="px-3 py-2.5 text-right">Documents</th>
                <th className="px-3 py-2.5 text-right">Deadline</th>
                <th className="px-5 py-2.5 text-right">At risk</th>
              </tr>
            </thead>
            <tbody>
              {byVendor.slice(0, 12).map((v) => (
                <tr
                  key={v.gstin}
                  onClick={() => onOpenVendor(v.gstin)}
                  className="cursor-pointer border-b border-[var(--color-line-hair)] last:border-0 hover:bg-[var(--color-surface)]"
                >
                  <td className="px-5 py-2.5 font-medium text-[var(--color-ink)]">{v.name}</td>
                  <td className="px-3 py-2.5 font-mono text-[11.5px] text-[var(--color-ink-muted)]">
                    {v.gstin || "—"}
                  </td>
                  <td className="tnum px-3 py-2.5 text-right text-[var(--color-ink-soft)]">{v.count}</td>
                  <td className="px-3 py-2.5 text-right text-[12px] text-[var(--color-ink-muted)]">
                    {v.deadline ? formatDate(v.deadline) : "—"}
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    <Money size="sm">{formatINR(v.amount)}</Money>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {byVendor.length > 12 && (
            <div className="border-t border-[var(--color-line)] px-5 py-2.5 text-[12px] text-[var(--color-ink-muted)]">
              {byVendor.length - 12} more supplier{byVendor.length - 12 === 1 ? "" : "s"} in the
              working papers export.
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------

/**
 * The tie-out. A CA checks this before they read anything else, so it is on
 * the face of the cockpit rather than buried in an export.
 */
function ControlTotalsPanel({ run }: { run: ReconciliationRun }) {
  const t = run.totals;
  const rows: Array<[string, string]> = [
    ["Credit claimed in the purchase register", formatINR(t.booksItc)],
    ["  of which matched to GSTR-2B", formatINR(t.matchedItc)],
    ["  of which unmatched", formatINR(t.booksOnlyItc)],
    ["Credit available per GSTR-2B", formatINR(t.gstr2bItc)],
    ["  of which not recorded in books", formatINR(t.gstr2bOnlyItc)],
  ];

  return (
    <Card className="print-avoid-break">
      <div className="flex items-center justify-between border-b border-[var(--color-line)] px-5 py-3.5">
        <div>
          <h3 className="text-[14px] font-semibold text-[var(--color-ink)]">Control totals</h3>
          <p className="mt-0.5 text-[12px] text-[var(--color-ink-muted)]">
            Every rupee of book credit is either matched or unmatched. Tie these to your source
            files before relying on anything above.
          </p>
        </div>
        <Badge tone={t.balanced ? "good" : "danger"}>{t.balanced ? "Balanced" : "Not balanced"}</Badge>
      </div>

      <table className="w-full text-[13px]">
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label} className="border-b border-[var(--color-line-hair)] last:border-0">
              <td
                className={cx(
                  "px-5 py-2",
                  label.startsWith("  ")
                    ? "pl-9 text-[var(--color-ink-muted)]"
                    : "font-medium text-[var(--color-ink)]",
                )}
              >
                {label.trim()}
              </td>
              <td className="px-5 py-2 text-right">
                <Money size="sm">{value}</Money>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {!t.balanced && t.imbalanceNote && (
        <div className="border-t border-[var(--color-danger-line)] bg-[var(--color-danger-bg)] px-5 py-3 text-[12.5px] leading-relaxed text-[var(--color-danger)]">
          {t.imbalanceNote}
        </div>
      )}
    </Card>
  );
}

function daysBetweenISO(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
