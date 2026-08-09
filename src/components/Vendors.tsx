"use client";

/**
 * The vendor ledger.
 *
 * Reconciliation is per-invoice; leverage is per-vendor. You cannot chase an
 * invoice — you chase the supplier who owes you the filing, and you decide
 * their payment terms, their onboarding, and whether to keep buying from them.
 * So this view rolls everything up to the counterparty and ranks by rupees at
 * risk rather than by invoice count.
 */

import { useMemo, useState } from "react";
import { ArrowUpDown, Minus, Search, ShieldCheck, ShieldX, TrendingDown, TrendingUp, X } from "lucide-react";
import type { ReconciliationRun, VendorProfile, VendorTrend } from "@/lib/domain/types";
import { formatINR, formatINRCompact } from "@/lib/domain/money";
import { formatDate } from "@/lib/domain/normalize";
import { stateNameFromGstin, validateGstin, GSTIN_ERROR_TEXT } from "@/lib/domain/gstin";
import { MSME_LABELS, RISK_BAND_LABELS, RISK_RULES } from "@/lib/export/labels";
import { Badge, Bar, Card, Citation, Money, cx, type Tone } from "./primitives";

const BAND_TONE: Record<VendorProfile["riskBand"], Tone> = {
  SEVERE: "danger",
  HIGH: "danger",
  WATCH: "warn",
  SAFE: "good",
};

type SortKey = "atRisk" | "score" | "exposure" | "name";

export function VendorLedger({
  run,
  focusGstin,
  onClearFocus,
}: {
  run: ReconciliationRun;
  focusGstin: string | null;
  onClearFocus: () => void;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("atRisk");

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? run.vendors.filter(
          (v) => v.name.toLowerCase().includes(q) || v.gstin.toLowerCase().includes(q),
        )
      : run.vendors;

    const sorted = [...filtered];
    sorted.sort((a, b) => {
      switch (sort) {
        case "score":
          return b.riskScore - a.riskScore;
        case "exposure":
          return b.itcExposure - a.itcExposure;
        case "name":
          return a.name.localeCompare(b.name);
        default:
          return b.itcAtRisk - a.itcAtRisk;
      }
    });
    return sorted;
  }, [run.vendors, query, sort]);

  const focused = focusGstin ? run.vendors.find((v) => v.gstin === focusGstin) ?? null : null;
  const maxAtRisk = Math.max(...run.vendors.map((v) => v.itcAtRisk), 1);

  return (
    <div className="space-y-5">
      {focused && <VendorDetail vendor={focused} run={run} onClose={onClearFocus} />}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-line)] px-5 py-3.5">
          <div>
            <h2 className="text-[15px] font-semibold text-[var(--color-ink)]">
              Suppliers by credit at risk
            </h2>
            <p className="mt-0.5 text-[12px] text-[var(--color-ink-muted)]">
              {run.vendors.length} counterparties this period. Two registrations of one PAN appear
              separately — they are distinct taxpayers.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <label className="relative">
              <Search
                size={14}
                strokeWidth={2}
                aria-hidden
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-ink-faint)]"
              />
              <span className="sr-only">Search suppliers</span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name or GSTIN"
                className="h-9 w-56 rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] pl-8 pr-3 text-[13px] text-[var(--color-ink)] placeholder:text-[var(--color-ink-faint)]"
              />
            </label>

            <label className="relative">
              <span className="sr-only">Sort suppliers by</span>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                className="h-9 cursor-pointer appearance-none rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] pl-8 pr-3 text-[13px] text-[var(--color-ink)]"
              >
                <option value="atRisk">At risk</option>
                <option value="score">Risk score</option>
                <option value="exposure">Total exposure</option>
                <option value="name">Name</option>
              </select>
              <ArrowUpDown
                size={13}
                strokeWidth={2}
                aria-hidden
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-ink-faint)]"
              />
            </label>
          </div>
        </div>

        <div className="scroll-slim overflow-x-auto">
          <table className="w-full min-w-[860px] text-[13px]">
            <thead>
              <tr className="border-b border-[var(--color-line)] text-left text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[var(--color-ink-muted)]">
                <th className="px-5 py-2.5">Supplier</th>
                <th className="px-3 py-2.5">Band</th>
                <th className="px-3 py-2.5">MSME</th>
                <th className="px-3 py-2.5 text-right">Invoices</th>
                <th className="px-3 py-2.5 text-right">Credit relied on</th>
                <th className="px-3 py-2.5 text-right">At risk</th>
                <th className="w-32 px-5 py-2.5">Share</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr
                  key={v.gstin}
                  className={cx(
                    "border-b border-[var(--color-line-hair)] last:border-0 hover:bg-[var(--color-surface-sunken)]",
                    focusGstin === v.gstin && "bg-[var(--color-gold-soft)]",
                  )}
                >
                  <td className="px-5 py-2.5">
                    <div className="flex items-center gap-2">
                      {v.gstinValid ? (
                        <ShieldCheck
                          size={13}
                          strokeWidth={2}
                          aria-label="GSTIN valid"
                          className="shrink-0 text-[var(--color-good)]"
                        />
                      ) : (
                        <ShieldX
                          size={13}
                          strokeWidth={2}
                          aria-label="GSTIN invalid"
                          className="shrink-0 text-[var(--color-danger)]"
                        />
                      )}
                      <span className="font-medium text-[var(--color-ink)]">{v.name}</span>
                    </div>
                    <div className="mt-0.5 pl-[21px] font-mono text-[11px] text-[var(--color-ink-muted)]">
                      {v.gstin || "no GSTIN"}
                      {stateNameFromGstin(v.gstin) && ` · ${stateNameFromGstin(v.gstin)}`}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge tone={BAND_TONE[v.riskBand]} showIcon={false}>
                      {RISK_BAND_LABELS[v.riskBand]} {v.riskScore}
                    </Badge>
                    <div className="mt-1">
                      <TrendIndicator trend={v.trend} deltaScore={v.trendDeltaScore} />
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-[12px] text-[var(--color-ink-soft)]">
                    {MSME_LABELS[v.msmeStatus]}
                  </td>
                  <td className="tnum px-3 py-2.5 text-right text-[var(--color-ink-soft)]">
                    {v.invoiceCount}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <Money size="sm">{formatINR(v.itcExposure)}</Money>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <Money size="sm" tone={v.itcAtRisk > 0 ? "danger" : undefined}>
                      {v.itcAtRisk > 0 ? formatINR(v.itcAtRisk) : "—"}
                    </Money>
                  </td>
                  <td className="px-5 py-2.5">
                    <Bar share={v.itcAtRisk / maxAtRisk} tone={BAND_TONE[v.riskBand]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {rows.length === 0 && (
          <div className="px-5 py-10 text-center text-[13px] text-[var(--color-ink-muted)]">
            No supplier matches “{query}”.
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

function VendorDetail({
  vendor,
  run,
  onClose,
}: {
  vendor: VendorProfile;
  run: ReconciliationRun;
  onClose: () => void;
}) {
  const findings = run.findings.filter((f) => f.supplierGstin === vendor.gstin);
  const decision = run.decisions.find((d) => d.supplierGstin === vendor.gstin);
  const validation = validateGstin(vendor.gstin);

  const upcoming = findings
    .filter((f) => f.deadline)
    .sort((a, b) => (a.deadline! < b.deadline! ? -1 : 1))
    .slice(0, 4);

  return (
    <Card className="animate-rise overflow-hidden border-[var(--color-gold-line)]">
      <div className="flex items-start justify-between gap-4 border-b border-[var(--color-line)] bg-[var(--color-gold-soft)] px-6 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[18px] font-semibold text-[var(--color-ink)]">{vendor.name}</h2>
            <Badge tone={BAND_TONE[vendor.riskBand]} showIcon={false}>
              {RISK_BAND_LABELS[vendor.riskBand]} · score {vendor.riskScore}/100
            </Badge>
          </div>
          <div className="mt-1 font-mono text-[12px] text-[var(--color-ink-soft)]">
            {vendor.gstin} · {stateNameFromGstin(vendor.gstin) ?? "unknown state"} ·{" "}
            {MSME_LABELS[vendor.msmeStatus]}
          </div>
          {!validation.valid && validation.error && (
            <div className="mt-2 text-[12.5px] font-medium text-[var(--color-danger)]">
              {GSTIN_ERROR_TEXT[validation.error]} — correct the vendor master before chasing this
              supplier.
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close supplier detail"
          className="shrink-0 cursor-pointer rounded-lg p-1.5 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface)]"
        >
          <X size={16} strokeWidth={2} aria-hidden />
        </button>
      </div>

      <div className="grid grid-cols-2 divide-x divide-[var(--color-line)] border-b border-[var(--color-line)] md:grid-cols-4">
        <MiniStat label="Credit relied on" value={formatINRCompact(vendor.itcExposure)} />
        <MiniStat
          label="At risk"
          value={formatINRCompact(vendor.itcAtRisk)}
          tone={vendor.itcAtRisk > 0 ? "danger" : "good"}
        />
        <MiniStat label="Invoices" value={String(vendor.invoiceCount)} />
        <MiniStat
          label="Periods with a miss"
          value={`${vendor.missedFilings} of ${vendor.observedPeriods}`}
          tone={vendor.missedFilings > 0 ? "warn" : "good"}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 px-6 py-5 lg:grid-cols-2">
        <div>
          <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-ink-muted)]">
            Why this supplier is scored here
          </h3>
          {vendor.findings.length === 0 ? (
            <p className="text-[13px] text-[var(--color-ink-muted)]">
              No findings. Every invoice reconciled cleanly and no clock is running.
            </p>
          ) : (
            <ul className="space-y-2.5">
              {vendor.findings.map((rule) => {
                const meta = RISK_RULES[rule];
                const amount = findings
                  .filter((f) => f.rule === rule)
                  .reduce((s, f) => s + f.amountAtRisk, 0);
                return (
                  <li key={rule} className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium text-[var(--color-ink)]">
                        {meta.label}
                      </div>
                      <Citation>{meta.citation}</Citation>
                    </div>
                    <Money size="sm" tone="danger">
                      {formatINR(amount)}
                    </Money>
                  </li>
                );
              })}
            </ul>
          )}

          <TrackRecord vendor={vendor} />
        </div>

        <div>
          <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-ink-muted)]">
            {decision ? "Payment recommendation" : "Upcoming deadlines"}
          </h3>

          {decision ? (
            <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-sunken)] p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[14px] font-semibold text-[var(--color-ink)]">
                  {decision.verdict.replace(/_/g, " ")}
                </span>
                <Money size="md">{formatINRCompact(decision.exposure)}</Money>
              </div>
              <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--color-ink-soft)]">
                {decision.rationale[0]}
              </p>
              <div className="mt-3 flex gap-4 text-[12px] text-[var(--color-ink-muted)]">
                <span>
                  Pay costs{" "}
                  <strong className="font-semibold text-[var(--color-ink)]">
                    {formatINRCompact(decision.costOfPaying)}
                  </strong>
                </span>
                <span>
                  Hold costs{" "}
                  <strong className="font-semibold text-[var(--color-ink)]">
                    {formatINRCompact(decision.costOfHolding)}
                  </strong>
                </span>
              </div>
            </div>
          ) : upcoming.length > 0 ? (
            <ul className="space-y-2">
              {upcoming.map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-3 text-[13px]">
                  <span className="text-[var(--color-ink-soft)]">{RISK_RULES[f.rule].label}</span>
                  <span className="text-[12px] font-medium text-[var(--color-ink)]">
                    {formatDate(f.deadline!)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-[var(--color-ink-muted)]">
              No open invoices awaiting a release decision.
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

/**
 * Word + icon + colour, never colour alone — the same rule the rest of this
 * codebase applies to severity. "Worsening" in red reads correctly even to a
 * colour-blind reader or on a black-and-white printout of the working papers.
 */
function TrendIndicator({
  trend,
  deltaScore,
}: {
  trend: VendorTrend;
  deltaScore: number | null;
}) {
  if (trend === "NEW") {
    return <span className="text-[10.5px] font-medium text-[var(--color-ink-faint)]">New this period</span>;
  }
  if (trend === "STABLE") {
    return (
      <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-[var(--color-ink-muted)]">
        <Minus size={11} strokeWidth={2.5} aria-hidden />
        Steady
      </span>
    );
  }

  const worsening = trend === "WORSENING";
  const Icon = worsening ? TrendingUp : TrendingDown;

  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 text-[10.5px] font-semibold",
        worsening ? "text-[var(--color-danger)]" : "text-[var(--color-good)]",
      )}
    >
      <Icon size={11} strokeWidth={2.5} aria-hidden />
      {worsening ? "Worsening" : "Improving"} {Math.abs(deltaScore ?? 0)}
    </span>
  );
}

/**
 * The cross-period view: is this vendor's behaviour a one-off or a pattern.
 * Only meaningful once there is at least one prior period on file — before
 * that, the honest thing to show is that there is nothing to compare yet,
 * not a trend invented from a single data point.
 */
function TrackRecord({ vendor }: { vendor: VendorProfile }) {
  if (vendor.periodsOfHistory === 0) {
    return (
      <div className="mt-5 border-t border-[var(--color-line-hair)] pt-4">
        <h4 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-ink-muted)]">
          Track record
        </h4>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--color-ink-muted)]">
          No prior period on file for this vendor yet. Reconcile next month and this will show
          whether they are improving, steady, or getting worse.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-5 border-t border-[var(--color-line-hair)] pt-4">
      <h4 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-ink-muted)]">
        Track record
      </h4>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px] text-[var(--color-ink-soft)]">
        <TrendIndicator trend={vendor.trend} deltaScore={vendor.trendDeltaScore} />
        <span>
          Based on {vendor.periodsOfHistory} prior period{vendor.periodsOfHistory === 1 ? "" : "s"}
        </span>
      </div>

      {vendor.consecutiveFlaggedPeriods > 1 && (
        <p className="mt-2 text-[12.5px] font-medium leading-relaxed text-[var(--color-danger)]">
          Flagged {vendor.consecutiveFlaggedPeriods} periods in a row, including this one — not a
          one-off.
        </p>
      )}

      {vendor.historicalMissRate !== null && (
        <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--color-ink-muted)]">
          Has averaged a {Math.round(vendor.historicalMissRate * 100)}% miss rate from GSTR-2B
          across its recorded history. The pay/hold recommendation for this vendor already accounts
          for this.
        </p>
      )}
    </div>
  );
}

function MiniStat({ label, value, tone = "neutral" }: { label: string; value: string; tone?: Tone }) {
  const toneClass = {
    danger: "text-[var(--color-danger)]",
    warn: "text-[var(--color-warn)]",
    good: "text-[var(--color-good)]",
    info: "text-[var(--color-info)]",
    neutral: "text-[var(--color-ink)]",
  }[tone];

  return (
    <div className="px-5 py-3.5">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[var(--color-ink-muted)]">
        {label}
      </div>
      <div className={cx("money mt-1 text-[17px] font-semibold", toneClass)}>{value}</div>
    </div>
  );
}
