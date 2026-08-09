"use client";

/**
 * The chase loop.
 *
 * The promise of this product is less work, not better-organised work. A list
 * of forty non-compliant suppliers is not less work — it is a to-do list. So
 * this screen writes the follow-up for you: a complete message, per supplier,
 * naming every affected document with its number, date and tax, in a register
 * the supplier's own accounts clerk can act on without a phone call.
 *
 * Tone matters commercially. These are ongoing trading relationships, often
 * decades old, and an accusatory template gets forwarded to the vendor's
 * proprietor and poisons a supply line over a filing error. The wording below
 * is firm about the money and neutral about blame.
 */

import { useMemo, useState } from "react";
import { Check, CheckCircle2, Copy, MessageSquare, Send } from "lucide-react";
import type { ReconciliationRun, RiskFinding } from "@/lib/domain/types";
import { formatINR, formatINRCompact } from "@/lib/domain/money";
import { formatDate, formatPeriod } from "@/lib/domain/normalize";
import { Badge, Button, Card, EmptyState, Money, cx } from "./primitives";

/** Same key shape page.tsx persists in `resolved` — one entry per vendor per period. */
function resolvedKey(gstin: string, period: string): string {
  return `${gstin}:${period}`;
}

/** Rules where the fix is genuinely in the supplier's hands. */
const CHASEABLE = new Set<RiskFinding["rule"]>([
  "SEC_16_2_AA_NOT_IN_2B",
  "RULE_37A_SUPPLIER_3B_UNFILED",
  "VALUE_MISMATCH",
  "SEC_16_4_TIME_BARRED",
]);

interface ChaseTarget {
  gstin: string;
  name: string;
  findings: RiskFinding[];
  amount: number;
  /** Soonest statutory deadline across the findings. */
  deadline?: string;
  /** Periods in a row, ending now, this vendor has carried genuine credit at risk. */
  consecutiveFlaggedPeriods: number;
}

export function ChaseComposer({
  run,
  companyName,
  companyGstin,
  resolved = [],
  onToggleResolved,
}: {
  run: ReconciliationRun;
  companyName: string;
  companyGstin: string;
  /** "gstin:period" keys already marked sent. */
  resolved?: string[];
  onToggleResolved?: (key: string) => void;
}) {
  const targets = useMemo<ChaseTarget[]>(() => {
    const map = new Map<string, ChaseTarget>();
    for (const f of run.findings) {
      if (!CHASEABLE.has(f.rule)) continue;
      let t = map.get(f.supplierGstin);
      if (!t) {
        const vendor = run.vendors.find((v) => v.gstin === f.supplierGstin);
        t = {
          gstin: f.supplierGstin,
          name: f.supplierName,
          findings: [],
          amount: 0,
          consecutiveFlaggedPeriods: vendor?.consecutiveFlaggedPeriods ?? 0,
        };
        map.set(f.supplierGstin, t);
      }
      t.findings.push(f);
      t.amount += f.amountAtRisk;
      if (f.deadline && (!t.deadline || f.deadline < t.deadline)) t.deadline = f.deadline;
    }
    return [...map.values()].sort((a, b) => b.amount - a.amount);
  }, [run.findings, run.vendors]);

  const [selected, setSelected] = useState<string | null>(targets[0]?.gstin ?? null);
  const [channel, setChannel] = useState<"email" | "whatsapp">("email");
  const [copied, setCopied] = useState(false);

  const target = targets.find((t) => t.gstin === selected) ?? targets[0] ?? null;
  const targetSent = target ? resolved.includes(resolvedKey(target.gstin, run.period)) : false;

  const message = useMemo(
    () =>
      target
        ? channel === "email"
          ? emailBody(target, run, companyName, companyGstin)
          : whatsappBody(target, run, companyName)
        : "",
    [target, channel, run, companyName, companyGstin],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      // Clipboard can be blocked by permissions policy. The textarea below is
      // selectable, so the user still has a path — say nothing rather than
      // throwing an error dialog at them.
    }
  }

  if (targets.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={Send}
          title="No supplier needs chasing"
          description="Every finding this period is something you resolve internally — corrections to your own books, or payment-timing decisions. Nothing is waiting on a supplier."
        />
      </Card>
    );
  }

  const totalChaseable = targets.reduce((s, t) => s + t.amount, 0);

  return (
    <div className="space-y-5">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div>
            <h2 className="text-[15px] font-semibold text-[var(--color-ink)]">
              {targets.length} supplier{targets.length === 1 ? "" : "s"} to chase
            </h2>
            <p className="mt-0.5 text-[12.5px] text-[var(--color-ink-muted)]">
              Holding {formatINRCompact(totalChaseable)} of your credit. Messages are pre-written
              with the full invoice schedule attached.
            </p>
          </div>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant={channel === "email" ? "primary" : "secondary"}
              onClick={() => setChannel("email")}
              icon={Send}
            >
              Email
            </Button>
            <Button
              size="sm"
              variant={channel === "whatsapp" ? "primary" : "secondary"}
              onClick={() => setChannel("whatsapp")}
              icon={MessageSquare}
            >
              WhatsApp
            </Button>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[300px_1fr]">
        <Card className="h-fit overflow-hidden">
          <div className="border-b border-[var(--color-line)] px-4 py-2.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[var(--color-ink-muted)]">
            Queue, largest first
          </div>
          <ul className="scroll-slim max-h-[560px] overflow-y-auto">
            {targets.map((t) => {
              const sent = resolved.includes(resolvedKey(t.gstin, run.period));
              return (
                <li key={t.gstin}>
                  <button
                    type="button"
                    onClick={() => setSelected(t.gstin)}
                    className={cx(
                      "flex w-full cursor-pointer items-start justify-between gap-3 border-b border-[var(--color-line-hair)] px-4 py-3 text-left transition-colors duration-150",
                      target?.gstin === t.gstin
                        ? "bg-[var(--color-gold-soft)]"
                        : "hover:bg-[var(--color-surface-sunken)]",
                    )}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-medium text-[var(--color-ink)]">
                        {t.name}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--color-ink-muted)]">
                        {sent && (
                          <CheckCircle2 size={11} strokeWidth={2.5} className="shrink-0 text-[var(--color-good)]" aria-hidden />
                        )}
                        <span>
                          {t.findings.length} document{t.findings.length === 1 ? "" : "s"}
                          {sent && " · sent"}
                        </span>
                      </div>
                    </div>
                    <Money size="sm" tone="danger">
                      {formatINRCompact(t.amount)}
                    </Money>
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>

        {target && (
          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--color-line)] px-5 py-3.5">
              <div>
                <h3 className="text-[14.5px] font-semibold text-[var(--color-ink)]">{target.name}</h3>
                <div className="mt-0.5 font-mono text-[11px] text-[var(--color-ink-muted)]">
                  {target.gstin}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {target.deadline && (
                  <Badge tone="warn">Deadline {formatDate(target.deadline)}</Badge>
                )}
                {onToggleResolved && (
                  <Button
                    size="sm"
                    icon={targetSent ? CheckCircle2 : undefined}
                    variant={targetSent ? "secondary" : "ghost"}
                    onClick={() => onToggleResolved(resolvedKey(target.gstin, run.period))}
                    title={targetSent ? "Mark as not yet sent" : "Mark this message as sent"}
                  >
                    {targetSent ? "Sent" : "Mark as sent"}
                  </Button>
                )}
                <Button size="sm" icon={copied ? Check : Copy} onClick={copy} variant="primary">
                  {copied ? "Copied" : "Copy message"}
                </Button>
              </div>
            </div>

            <label className="sr-only" htmlFor="chase-message">
              Generated chase message for {target.name}
            </label>
            <textarea
              id="chase-message"
              readOnly
              value={message}
              rows={22}
              className="scroll-slim w-full resize-y border-0 bg-[var(--color-surface)] px-5 py-4 font-mono text-[12px] leading-relaxed text-[var(--color-ink)] focus:outline-none"
            />
          </Card>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message templates
// ---------------------------------------------------------------------------

function invoiceLines(target: ChaseTarget, run: ReconciliationRun): string[] {
  const lines: string[] = [];
  for (const f of target.findings) {
    for (const matchId of f.matchIds) {
      const m = run.matches.find((x) => x.id === matchId);
      const doc = m?.purchase ?? m?.gstr2b;
      if (!doc) continue;
      lines.push(
        `  ${doc.invoiceNumber.padEnd(24)} ${formatDate(doc.invoiceDate).padEnd(13)} ${formatINR(f.amountAtRisk)}`,
      );
    }
  }
  return [...new Set(lines)];
}

function emailBody(
  target: ChaseTarget,
  run: ReconciliationRun,
  companyName: string,
  companyGstin: string,
): string {
  const period = formatPeriod(run.period);
  const lines = invoiceLines(target, run);
  const notIn2b = target.findings.filter((f) => f.rule === "SEC_16_2_AA_NOT_IN_2B").length;
  const unfiled3b = target.findings.filter((f) => f.rule === "RULE_37A_SUPPLIER_3B_UNFILED").length;

  const issue: string[] = [];
  if (notIn2b > 0) {
    issue.push(
      `${notIn2b} invoice${notIn2b === 1 ? " does" : "s do"} not appear in our GSTR-2B for ${period}, which suggests ${notIn2b === 1 ? "it has" : "they have"} not yet been reported in your GSTR-1.`,
    );
  }
  if (unfiled3b > 0) {
    issue.push(
      `${unfiled3b} invoice${unfiled3b === 1 ? " is" : "s are"} reflected in our GSTR-2B, but our records indicate the corresponding GSTR-3B has not been filed. Under Rule 37A we are required to reverse this credit if the return remains unfiled.`,
    );
  }

  // A repeat pattern is worth naming plainly — it is the single fact most
  // likely to get a slow-moving vendor to actually fix their process, and it
  // is stated as an observation about timing, not an accusation.
  if (target.consecutiveFlaggedPeriods > 1) {
    issue.push(
      `This is the ${ordinal(target.consecutiveFlaggedPeriods)} consecutive month we have had to raise a reconciliation gap with your GSTIN, so we would appreciate a look at the filing process on your end rather than a one-off correction.`,
    );
  }

  return `Subject: GST input credit reconciliation — ${period} — ${formatINRCompact(target.amount)} pending

Dear Sir / Madam,

We are completing our GST reconciliation for ${period} and have identified documents from ${target.name} (GSTIN ${target.gstin}) where the input tax credit is not currently available to us.

${issue.join("\n\n")}

The documents concerned:

  Invoice number           Date          Credit
  ${"-".repeat(52)}
${lines.join("\n")}
  ${"-".repeat(52)}
  Total                                  ${formatINR(target.amount)}
${target.deadline ? `\nWe would be grateful if this could be regularised before ${formatDate(target.deadline)}, after which the credit is no longer available to us under the GST law.` : ""}

If any of these documents have been reported under a different invoice number or period, please let us know the reference and we will trace them at our end — in our experience roughly half of such differences turn out to be a numbering mismatch rather than a filing gap.

Please treat this as a request for correction rather than a dispute. We value the relationship and simply need the credit to flow through correctly.

Kind regards,

Accounts Payable
${companyName}
GSTIN ${companyGstin}`;
}

function whatsappBody(target: ChaseTarget, run: ReconciliationRun, companyName: string): string {
  const period = formatPeriod(run.period);
  const count = target.findings.length;

  const streakLine =
    target.consecutiveFlaggedPeriods > 1
      ? `\nThis is the ${ordinal(target.consecutiveFlaggedPeriods)} month running we've had to flag something similar — would help to sort the process on your end.\n`
      : "";

  return `Namaste 🙏

This is ${companyName} (Accounts).

For ${period}, ${count} of your invoice${count === 1 ? "" : "s"} totalling ${formatINRCompact(target.amount)} in GST credit ${count === 1 ? "is" : "are"} not showing in our GSTR-2B.
${streakLine}
${invoiceLines(target, run)
  .slice(0, 8)
  .map((l) => l.trim())
  .join("\n")}${count > 8 ? `\n...and ${count - 8} more` : ""}

Could you please check whether these were included in your GSTR-1${target.deadline ? `, ideally before ${formatDate(target.deadline)}` : ""}?

If they were filed under a different invoice number, please share the reference and we will match them at our end.

We have sent the full list on email as well. Thank you.`;
}

/** 1st, 2nd, 3rd, 4th... — reads naturally in a sentence about consecutive months. */
function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}
