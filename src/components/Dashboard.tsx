"use client";

/**
 * The signed-in shell.
 *
 * Extracted from the route so that both the live session (`/`, restored from
 * localStorage) and the public demo (`/demo`, generated server-side) render
 * exactly the same component tree. A demo that drifts from the real product is
 * worse than no demo, and the shared path means it cannot drift.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Database, FileWarning, Gauge, ListChecks, Plug, Scale, Send, Users } from "lucide-react";
import type { BankDetails, GSTR2BRecord, PurchaseRecord } from "@/lib/domain/types";
import { runReconciliation, snapshotVendors } from "@/lib/engine/run";
import { formatINRCompact } from "@/lib/domain/money";
import { formatPeriod } from "@/lib/domain/normalize";
import type { CompanyProfile } from "@/lib/store/session";
import { loadVendorHistoryExcluding, recordVendorPeriod } from "@/lib/store/vendor-history";
import { downloadCsv } from "@/lib/export/csv";
import { Cockpit } from "./Cockpit";
import { PayHoldBoard } from "./PayHold";
import { VendorLedger } from "./Vendors";
import { MatchExplorer } from "./Matches";
import { ChaseComposer } from "./Chase";
import { cx } from "./primitives";

export type View = "cockpit" | "payhold" | "vendors" | "matches" | "chase";

export interface DashboardData {
  purchases: PurchaseRecord[];
  gstr2b: GSTR2BRecord[];
  asOf: string;
  period: string;
  company: CompanyProfile;
  sources: { register?: string; portal?: string };
  /** Beneficiary bank details recovered from a Tally ledger pull, by GSTIN. */
  bankDirectory?: Record<string, BankDetails>;
}

interface NavItem {
  key: View;
  label: string;
  icon: typeof Gauge;
  hint: string;
}

/**
 * Grouped by job, not by feature name.
 *
 * Five flat tabs named after what each screen does (Cockpit, Chase, Working
 * papers…) reads as a feature list. The same five screens grouped by who
 * reaches for them and when — a glance for the executive, this week's work
 * for AP, the proof for compliance and the CA — reads as a system with a
 * shape. No new screens here, purely a regroup of the existing five.
 */
const NAV_ZONES: Array<{ zone: string; items: NavItem[] }> = [
  {
    zone: "Overview",
    items: [{ key: "cockpit", label: "Cockpit", icon: Gauge, hint: "What is at risk and what to do" }],
  },
  {
    zone: "Act",
    items: [
      { key: "payhold", label: "Pay or hold", icon: Scale, hint: "The release decision, priced" },
      { key: "chase", label: "Chase", icon: Send, hint: "Pre-written supplier follow-ups" },
    ],
  },
  {
    zone: "Audit",
    items: [
      { key: "vendors", label: "Suppliers", icon: Users, hint: "Risk scorecard by counterparty" },
      { key: "matches", label: "Working papers", icon: ListChecks, hint: "Line-by-line drilldown" },
    ],
  },
];

const NAV: NavItem[] = NAV_ZONES.flatMap((z) => z.items);

export function Dashboard({
  data,
  saveWarning,
  onReset,
  onClearHistory,
  demoBanner,
  historyEnabled = false,
  resolved = [],
  onToggleResolved,
}: {
  data: DashboardData;
  saveWarning?: string | null;
  onReset?: () => void;
  onClearHistory?: () => void;
  demoBanner?: React.ReactNode;
  /** Chase messages marked sent, as "gstin:period" keys. */
  resolved?: string[];
  onToggleResolved?: (key: string) => void;
  /**
   * Read and write cross-period vendor history for this run. Defaults to
   * false so a server-rendered page — the public `/demo` above all — never
   * depends on, or writes to, this specific visitor's browser storage. The
   * demo must render identical output for every visitor and on the server;
   * a real session (mounted only client-side, after `page.tsx` restores or
   * accepts an upload) opts in explicitly.
   */
  historyEnabled?: boolean;
}) {
  const [view, setView] = useState<View>("cockpit");
  const [focusGstin, setFocusGstin] = useState<string | null>(null);
  const [historyWarning, setHistoryWarning] = useState<string | null>(null);

  // What we know about these vendors from periods before this one. Excludes
  // the current period explicitly — history must never include the thing
  // it is being compared against, or every trend would read STABLE by
  // construction. Safe to read synchronously: this component only ever
  // mounts client-side when historyEnabled is true (see the prop doc above),
  // so there is no server-rendered counterpart for a localStorage read to
  // disagree with.
  const vendorHistory = useMemo(
    () => (historyEnabled ? loadVendorHistoryExcluding(data.period) : undefined),
    [historyEnabled, data.period],
  );

  // Derived, never stored. The engine is pure and runs in well under a second,
  // so an engine fix applies to a restored session immediately rather than
  // leaving a stale result frozen in storage.
  const run = useMemo(
    () =>
      runReconciliation(data.purchases, data.gstr2b, {
        asOf: data.asOf,
        period: data.period,
        msmeWrittenAgreement: data.company.msmeWrittenAgreement,
        vendorHistory,
      }),
    [data, vendorHistory],
  );

  // Record this run's vendor scores as history for next time. Runs once per
  // distinct run (data only changes on a genuine new upload or restore, not
  // on every render), and never for the sample dataset or the public demo —
  // see the historyEnabled doc above for why that separation matters.
  useEffect(() => {
    if (!historyEnabled) return;
    const result = recordVendorPeriod(snapshotVendors(run));
    setHistoryWarning(result.ok ? null : result.reason);
  }, [run, historyEnabled]);

  const openVendor = useCallback((gstin: string) => {
    setFocusGstin(gstin);
    setView("vendors");
  }, []);

  /**
   * SheetJS is a large dependency and most sessions never export, so the
   * workbook builder is loaded on demand rather than shipped in the initial
   * bundle.
   */
  const handleExport = useCallback(() => {
    void (async () => {
      const [{ buildWorkbook, workbookFilename }, { downloadWorkbook }] = await Promise.all([
        import("@/lib/export/workbook"),
        import("@/lib/export/download"),
      ]);

      const meta = {
        companyName: data.company.name,
        companyGstin: data.company.gstin,
        period: data.period,
        generatedAt: new Date().toISOString(),
        preparedBy: "ITC Guard",
      };

      downloadWorkbook(buildWorkbook(run, meta), workbookFilename(meta));
    })();
  }, [run, data.company, data.period]);

  /**
   * Where a recommendation turns into an action: a beneficiary file ready for
   * a bank's bulk NEFT/RTGS upload, built only from what Pay/Hold actually
   * approved for release this run.
   */
  const handleGeneratePaymentFile = useCallback(() => {
    void import("@/lib/export/payment-file").then(({ buildPaymentFile, paymentFileCsv, paymentFileFilename }) => {
      const summary = buildPaymentFile(run.decisions, run.matches, data.bankDirectory ?? {}, data.period);
      downloadCsv(paymentFileFilename(data.period), paymentFileCsv(summary));
    });
  }, [run, data.bankDirectory, data.period]);

  return (
    <div className="flex min-h-dvh">
      <aside className="no-print sticky top-0 hidden h-dvh w-[248px] shrink-0 flex-col border-r border-[var(--color-line)] bg-[var(--color-surface)] lg:flex">
        <div className="border-b border-[var(--color-line)] px-5 py-5">
          <div className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-[var(--color-navy)] text-[13px] font-bold text-white">
              ₹
            </span>
            <span className="text-[15px] font-semibold tracking-tight text-[var(--color-ink)]">
              ITC Guard
            </span>
          </div>
          <div className="mt-3.5 truncate text-[12.5px] font-medium text-[var(--color-ink-soft)]">
            {data.company.name}
          </div>
          <div className="font-mono text-[10.5px] text-[var(--color-ink-muted)]">
            {data.company.gstin}
          </div>
        </div>

        <div className="border-b border-[var(--color-line)] px-5 py-4">
          <div className="text-[10px] font-semibold uppercase tracking-[0.13em] text-[var(--color-ink-muted)]">
            {formatPeriod(data.period)} · at risk
          </div>
          <div className="money mt-1 text-[22px] font-semibold text-[var(--color-danger)]">
            {formatINRCompact(run.totalAtRisk)}
          </div>
        </div>

        <nav className="flex-1 px-3 py-3">
          {NAV_ZONES.map((z, zi) => (
            <div key={z.zone} className={zi > 0 ? "mt-4" : undefined}>
              <div className="px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.13em] text-[var(--color-ink-faint)]">
                {z.zone}
              </div>
              <ul className="space-y-0.5">
                {z.items.map((item) => {
                  const active = view === item.key;
                  return (
                    <li key={item.key}>
                      <button
                        type="button"
                        onClick={() => setView(item.key)}
                        aria-current={active ? "page" : undefined}
                        className={cx(
                          "flex w-full cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-150",
                          active
                            ? "bg-[var(--color-navy)] text-white"
                            : "text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-sunken)]",
                        )}
                      >
                        <item.icon size={15} strokeWidth={2} aria-hidden className="mt-0.5 shrink-0" />
                        <span className="min-w-0">
                          <span className="block text-[13px] font-medium">{item.label}</span>
                          <span
                            className={cx(
                              "block text-[11px] leading-snug",
                              active ? "text-white/70" : "text-[var(--color-ink-muted)]",
                            )}
                          >
                            {item.hint}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-[var(--color-line)] px-5 py-4">
          <p className="flex items-start gap-2 text-[11px] leading-relaxed text-[var(--color-ink-muted)]">
            <Database size={12} strokeWidth={2} className="mt-0.5 shrink-0" aria-hidden />
            <span>
              Your ledger is processed in this browser and stored only on this device. Nothing is
              uploaded.
            </span>
          </p>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
            {onReset && (
              <button
                type="button"
                onClick={onReset}
                className="cursor-pointer text-[11.5px] font-medium text-[var(--color-ink-muted)] underline-offset-2 hover:text-[var(--color-danger)] hover:underline"
              >
                Clear this session
              </button>
            )}
            {onClearHistory && (
              <button
                type="button"
                onClick={onClearHistory}
                className="cursor-pointer text-[11.5px] font-medium text-[var(--color-ink-muted)] underline-offset-2 hover:text-[var(--color-danger)] hover:underline"
                title="Removes the month-over-month vendor track record. This run is unaffected."
              >
                Clear vendor history
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                void fetch("/api/auth/logout", { method: "POST" }).then(() => {
                  // Full navigation rather than a client-side route change, so
                  // every in-memory copy of the ledger is dropped with the page.
                  window.location.href = "/login";
                });
              }}
              className="cursor-pointer text-[11.5px] font-medium text-[var(--color-ink-muted)] underline-offset-2 hover:text-[var(--color-ink)] hover:underline"
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        {/* Mobile navigation. The sidebar is hidden below lg, so this is the
            only way through the app on a tablet in a factory office. */}
        <div className="no-print scroll-slim sticky top-0 z-20 flex gap-1 overflow-x-auto border-b border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-2 lg:hidden">
          {NAV.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setView(item.key)}
              aria-current={view === item.key ? "page" : undefined}
              className={cx(
                "shrink-0 cursor-pointer rounded-lg px-3 py-2 text-[12.5px] font-medium",
                view === item.key
                  ? "bg-[var(--color-navy)] text-white"
                  : "text-[var(--color-ink-soft)]",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="mx-auto max-w-[1180px] px-5 py-7 lg:px-10 lg:py-8">
          {demoBanner}

          {saveWarning && (
            <div className="no-print mb-5 flex items-start gap-2.5 rounded-lg border border-[var(--color-warn-line)] bg-[var(--color-warn-bg)] px-4 py-3 text-[12.5px] leading-relaxed text-[var(--color-warn)]">
              <FileWarning size={15} strokeWidth={2} className="mt-px shrink-0" aria-hidden />
              <span>{saveWarning}</span>
            </div>
          )}

          {historyWarning && (
            <div className="no-print mb-5 flex items-start gap-2.5 rounded-lg border border-[var(--color-warn-line)] bg-[var(--color-warn-bg)] px-4 py-3 text-[12.5px] leading-relaxed text-[var(--color-warn)]">
              <FileWarning size={15} strokeWidth={2} className="mt-px shrink-0" aria-hidden />
              <span>{historyWarning}</span>
            </div>
          )}

          {view === "cockpit" && (
            <Cockpit run={run} asOf={data.asOf} onOpenVendor={openVendor} onExport={handleExport} />
          )}
          {view === "payhold" && (
            <PayHoldBoard run={run} onOpenVendor={openVendor} onGeneratePaymentFile={handleGeneratePaymentFile} />
          )}
          {view === "chase" && (
            <ChaseComposer
              run={run}
              companyName={data.company.name}
              companyGstin={data.company.gstin}
              resolved={resolved}
              onToggleResolved={onToggleResolved}
            />
          )}
          {view === "vendors" && (
            <VendorLedger
              run={run}
              focusGstin={focusGstin}
              onClearFocus={() => setFocusGstin(null)}
            />
          )}
          {view === "matches" && <MatchExplorer run={run} />}
        </div>
      </main>
    </div>
  );
}
