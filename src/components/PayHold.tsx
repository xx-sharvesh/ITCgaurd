"use client";

/**
 * The pay / hold board.
 *
 * This is the screen no other GST product has, and the one that justifies the
 * price. Every other tool stops at "here is your mismatch". This one answers
 * the question the finance team actually has on a Friday afternoon: do I
 * release this payment or not?
 *
 * The recommendation is never presented as an oracle. Both costs are shown
 * side by side, the binding constraint is named, and the loss probability is
 * labelled an estimate — because it is one. A CFO who cannot see the working
 * will not overrule the tool when it is wrong, and it will sometimes be wrong.
 */

import { useMemo, useState } from "react";
import { Banknote, ChevronDown, Scale, Wallet } from "lucide-react";
import type { PayHoldDecision, ReconciliationRun } from "@/lib/domain/types";
import { formatINR, formatINRCompact } from "@/lib/domain/money";
import { formatDate } from "@/lib/domain/normalize";
import { RISK_RULES, VERDICT_LABELS } from "@/lib/export/labels";
import { Badge, Button, Card, Citation, EmptyState, Money, cx, type Tone } from "./primitives";

type Verdict = PayHoldDecision["verdict"];

const VERDICT_TONE: Record<Verdict, Tone> = {
  PAY: "good",
  PAY_NET_OF_GST: "info",
  HOLD: "danger",
  ESCALATE: "warn",
};

/** One line explaining what the verdict means operationally, not legally. */
const VERDICT_INSTRUCTION: Record<Verdict, string> = {
  PAY: "Release the payment on normal terms.",
  PAY_NET_OF_GST:
    "Release the taxable value; retain the tax component until the invoice appears in GSTR-2B.",
  HOLD: "Withhold the full balance until the supplier evidences filing.",
  ESCALATE: "Neither option is clearly cheaper. Decide commercially, on the facts below.",
};

const FILTERS: Array<{ key: Verdict | "ALL"; label: string }> = [
  { key: "ALL", label: "All" },
  { key: "HOLD", label: "Hold" },
  { key: "PAY_NET_OF_GST", label: "Pay net of GST" },
  { key: "ESCALATE", label: "Escalate" },
  { key: "PAY", label: "Pay" },
];

export function PayHoldBoard({
  run,
  onOpenVendor,
  onGeneratePaymentFile,
}: {
  run: ReconciliationRun;
  onOpenVendor: (gstin: string) => void;
  /** Builds and downloads a bulk NEFT/RTGS beneficiary file from every PAY / PAY_NET_OF_GST decision below. */
  onGeneratePaymentFile?: () => void;
}) {
  const [filter, setFilter] = useState<Verdict | "ALL">("ALL");
  const payableCount = run.decisions.filter(
    (d) => d.verdict === "PAY" || d.verdict === "PAY_NET_OF_GST",
  ).length;

  const counts = useMemo(() => {
    const c: Record<string, number> = { ALL: run.decisions.length };
    for (const d of run.decisions) c[d.verdict] = (c[d.verdict] ?? 0) + 1;
    return c;
  }, [run.decisions]);

  const visible = useMemo(
    () => (filter === "ALL" ? run.decisions : run.decisions.filter((d) => d.verdict === filter)),
    [run.decisions, filter],
  );

  const heldValue = run.decisions
    .filter((d) => d.verdict === "HOLD")
    .reduce((s, d) => s + d.exposure, 0);
  const netOfGstValue = run.decisions
    .filter((d) => d.verdict === "PAY_NET_OF_GST")
    .reduce((s, d) => s + d.costOfPaying, 0);

  return (
    <div className="space-y-6">
      <Card>
        <div className="border-b border-[var(--color-line)] px-6 py-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                <Scale size={15} strokeWidth={2} className="text-[var(--color-gold)]" aria-hidden />
                <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-gold)]">
                  The payment release decision
                </span>
              </div>
              <h1 className="mt-3 max-w-3xl text-[24px] font-semibold leading-tight tracking-tight text-[var(--color-ink)]">
                Three provisions in two Acts pull this decision in opposite directions. Here is what each
                branch costs.
              </h1>
              <p className="mt-3 max-w-3xl text-[13.5px] leading-relaxed text-[var(--color-ink-soft)]">
                Paying a supplier who never files loses the credit under Sec 16(2)(aa). Holding a
                registered micro or small enterprise past its limit defers the deduction under Sec 43B(h)
                of the Income-tax Act. Holding anyone past 180 days reverses the credit with interest
                under Rule 37. Every recommendation below prices all three and names the constraint that
                decided it.
              </p>
            </div>
            {onGeneratePaymentFile && (
              <Button
                variant="primary"
                icon={Banknote}
                onClick={onGeneratePaymentFile}
                disabled={payableCount === 0}
                title={
                  payableCount === 0
                    ? "No supplier is currently clear to pay"
                    : `Builds a bulk NEFT/RTGS beneficiary file for ${payableCount} approved release${payableCount === 1 ? "" : "s"}`
                }
              >
                Generate payment file
              </Button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 divide-y divide-[var(--color-line)] sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <SummaryTile
            label="Recommended for hold"
            value={formatINRCompact(heldValue)}
            sub={`${counts.HOLD ?? 0} supplier${(counts.HOLD ?? 0) === 1 ? "" : "s"} — full balance withheld`}
            tone="danger"
          />
          <SummaryTile
            label="Tax withheld, goods paid"
            value={formatINRCompact(netOfGstValue)}
            sub={`${counts.PAY_NET_OF_GST ?? 0} supplier${(counts.PAY_NET_OF_GST ?? 0) === 1 ? "" : "s"} — protects the risk, keeps the relationship`}
            tone="info"
          />
          <SummaryTile
            label="Clear to release"
            value={String(counts.PAY ?? 0)}
            sub="Filing reliably, no clock pressing"
            tone="good"
          />
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={cx(
              "cursor-pointer rounded-lg border px-3 py-1.5 text-[12.5px] font-medium transition-colors duration-150",
              filter === f.key
                ? "border-[var(--color-navy)] bg-[var(--color-navy)] text-white"
                : "border-[var(--color-line-strong)] bg-[var(--color-surface)] text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-sunken)]",
            )}
          >
            {f.label}
            <span className="ml-1.5 opacity-60">{counts[f.key] ?? 0}</span>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <Card>
          <EmptyState
            icon={Wallet}
            title="No open decisions in this view"
            description="Every supplier in this category is either fully settled or has no open invoices awaiting release."
          />
        </Card>
      ) : (
        <div className="stagger space-y-3">
          {visible.map((d) => (
            <DecisionCard key={d.supplierGstin} decision={d} onOpenVendor={onOpenVendor} />
          ))}
        </div>
      )}
    </div>
  );
}

function SummaryTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: Tone;
}) {
  const toneClass = {
    danger: "text-[var(--color-danger)]",
    warn: "text-[var(--color-warn)]",
    good: "text-[var(--color-good)]",
    info: "text-[var(--color-info)]",
    neutral: "text-[var(--color-ink)]",
  }[tone];

  return (
    <div className="px-6 py-4">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[var(--color-ink-muted)]">
        {label}
      </div>
      <div className={cx("money mt-1.5 text-[21px] font-semibold", toneClass)}>{value}</div>
      <div className="mt-1 text-[11.5px] leading-snug text-[var(--color-ink-muted)]">{sub}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function DecisionCard({
  decision: d,
  onOpenVendor,
}: {
  decision: PayHoldDecision;
  onOpenVendor: (gstin: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const tone = VERDICT_TONE[d.verdict];

  // Scale the two cost bars against each other so the comparison is visual as
  // well as numeric — this is fundamentally a "which is bigger" question.
  const worst = Math.max(d.costOfPaying, d.costOfHolding, 1);

  return (
    <Card className="print-avoid-break overflow-hidden">
      <div className="flex flex-wrap items-start gap-4 px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={tone}>{VERDICT_LABELS[d.verdict]}</Badge>
            <button
              type="button"
              onClick={() => onOpenVendor(d.supplierGstin)}
              className="cursor-pointer text-[15px] font-semibold text-[var(--color-ink)] hover:text-[var(--color-gold)]"
            >
              {d.supplierName}
            </button>
            <span className="font-mono text-[11px] text-[var(--color-ink-muted)]">
              {d.supplierGstin}
            </span>
          </div>

          <p className="mt-2 text-[13.5px] font-medium text-[var(--color-ink-soft)]">
            {VERDICT_INSTRUCTION[d.verdict]}
          </p>

          {d.bindingConstraint !== "NONE" && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-[var(--color-ink-muted)]">
              <span>Binding constraint:</span>
              <strong className="font-semibold text-[var(--color-ink)]">
                {RISK_RULES[d.bindingConstraint].label}
              </strong>
              <Citation>{RISK_RULES[d.bindingConstraint].citation}</Citation>
            </div>
          )}
        </div>

        <div className="shrink-0 text-right">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[var(--color-ink-muted)]">
            Balance outstanding
          </div>
          <Money size="lg">{formatINRCompact(d.exposure)}</Money>
          {d.decideBy && (
            <div className="mt-1 text-[11.5px] text-[var(--color-ink-muted)]">
              Decide by {formatDate(d.decideBy)}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-px border-t border-[var(--color-line)] bg-[var(--color-line)] sm:grid-cols-2">
        <CostPanel
          label="Cost of paying now"
          amount={d.costOfPaying}
          share={d.costOfPaying / worst}
          tone="danger"
          caption="Expected credit lost if the supplier never files"
        />
        <CostPanel
          label="Cost of holding"
          amount={d.costOfHolding}
          share={d.costOfHolding / worst}
          tone="warn"
          caption="Deduction deferred and interest on reversal"
        />
      </div>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center justify-between border-t border-[var(--color-line)] px-5 py-2.5 text-[12.5px] font-medium text-[var(--color-ink-soft)] transition-colors duration-150 hover:bg-[var(--color-surface-sunken)]"
      >
        <span>
          {open ? "Hide" : "Show"} the working — {d.matchIds.length} open invoice
          {d.matchIds.length === 1 ? "" : "s"}
        </span>
        <ChevronDown
          size={16}
          strokeWidth={2}
          aria-hidden
          className={cx("transition-transform duration-200 ease-out", open && "rotate-180")}
        />
      </button>

      {open && (
        <ol className="animate-fade space-y-2 border-t border-[var(--color-line)] bg-[var(--color-surface-sunken)] px-5 py-4">
          {d.rationale.map((line, i) => (
            <li key={i} className="flex gap-3 text-[13px] leading-relaxed text-[var(--color-ink-soft)]">
              <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[var(--color-ink-faint)]" />
              <span>{line}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function CostPanel({
  label,
  amount,
  share,
  tone,
  caption,
}: {
  label: string;
  amount: number;
  share: number;
  tone: Tone;
  caption: string;
}) {
  const fill = tone === "danger" ? "bg-[var(--color-danger)]" : "bg-[var(--color-warn)]";
  const text = tone === "danger" ? "text-[var(--color-danger)]" : "text-[var(--color-warn)]";

  return (
    <div className="bg-[var(--color-surface)] px-5 py-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[var(--color-ink-muted)]">
          {label}
        </span>
        <span className={cx("money text-[15px] font-semibold", text)}>{formatINR(amount)}</span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-sunken)]">
        <div
          className={cx("h-full rounded-full transition-[width] duration-500 ease-out", fill)}
          style={{ width: `${Math.max(2, Math.min(100, share * 100))}%` }}
        />
      </div>
      <p className="mt-1.5 text-[11.5px] leading-snug text-[var(--color-ink-muted)]">{caption}</p>
    </div>
  );
}
