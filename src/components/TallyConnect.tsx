"use client";

/**
 * Connect directly to Tally, instead of exporting a file every month.
 *
 * This is the difference between a tool that asks for a fresh manual upload
 * every single month and one that just... already has the data. The gateway
 * this talks to only ever runs on the same machine or the same office
 * network as this browser — see the SSRF guard in `lib/tally/url-guard.ts`
 * for why that boundary is enforced server-side, not just assumed.
 *
 * GSTR-2B still has to be a manual download: it lives behind an OTP-gated
 * government login this product has no business trying to automate. Half the
 * manual work disappearing is still real progress — say so plainly rather
 * than implying more than is true.
 */

import { useCallback, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, Plug, RefreshCw } from "lucide-react";
import type { BankDetails, PurchaseRecord } from "@/lib/domain/types";
import { Button, Card, cx } from "./primitives";

const DEFAULT_URL = "http://localhost:9000";

interface TallyCompany {
  name: string;
  startingFrom?: string;
}

interface TallyErrorPayload {
  kind: string;
  message: string;
  hint: string;
  detail?: string;
}

type Phase = "idle" | "probing" | "connected" | "pulling";

/** Last full calendar month — the range someone reconciling a closed period actually wants by default. */
function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const firstOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastOfPrevMonth = new Date(firstOfThisMonth.getTime() - 86_400_000);
  const firstOfPrevMonth = new Date(lastOfPrevMonth.getFullYear(), lastOfPrevMonth.getMonth(), 1);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(firstOfPrevMonth), to: iso(lastOfPrevMonth) };
}

export function TallyConnect({
  onPulled,
  disabled,
}: {
  onPulled: (records: PurchaseRecord[], bankDirectory: Record<string, BankDetails>, sourceLabel: string) => void;
  disabled?: boolean;
}) {
  const [url, setUrl] = useState(DEFAULT_URL);
  const [phase, setPhase] = useState<Phase>("idle");
  const [companies, setCompanies] = useState<TallyCompany[]>([]);
  const [company, setCompany] = useState("");
  const range = useMemo(defaultRange, []);
  const [fromDate, setFromDate] = useState(range.from);
  const [toDate, setToDate] = useState(range.to);
  const [error, setError] = useState<TallyErrorPayload | null>(null);
  const [result, setResult] = useState<{
    vouchersSeen: number;
    records: number;
    warnings: number;
    gstinsFilled: number;
    bankDetailsFound: number;
    truncated: boolean;
  } | null>(null);

  const testConnection = useCallback(async () => {
    setPhase("probing");
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/tally", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "probe", url }),
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error as TallyErrorPayload);
        setPhase("idle");
        return;
      }
      setCompanies(json.companies ?? []);
      setCompany(json.companies?.[0]?.name ?? "");
      setPhase("connected");
    } catch {
      setError({
        kind: "NETWORK_ERROR",
        message: "Could not reach the ITC Guard server itself.",
        hint: "Check that the app is still running and reload the page.",
      });
      setPhase("idle");
    }
  }, [url]);

  const pullRegister = useCallback(async () => {
    if (!company) return;
    setPhase("pulling");
    setError(null);
    try {
      const res = await fetch("/api/tally", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "purchases", url, company, fromDate, toDate }),
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error as TallyErrorPayload);
        setPhase("connected");
        return;
      }

      const bankDirectory = (json.bankDirectory ?? {}) as Record<string, BankDetails>;
      setResult({
        vouchersSeen: json.vouchersSeen ?? 0,
        records: json.records?.length ?? 0,
        warnings: json.warnings?.length ?? 0,
        gstinsFilled: json.gstinsFilledFromLedgers ?? 0,
        bankDetailsFound: Object.keys(bankDirectory).length,
        truncated: Boolean(json.truncated),
      });
      setPhase("connected");
      onPulled(
        json.records as PurchaseRecord[],
        bankDirectory,
        `Tally: ${company} (${fromDate} to ${toDate})`,
      );
    } catch {
      setError({
        kind: "NETWORK_ERROR",
        message: "Could not reach the ITC Guard server itself.",
        hint: "Check that the app is still running and reload the page.",
      });
      setPhase("connected");
    }
  }, [url, company, fromDate, toDate, onPulled]);

  const busy = phase === "probing" || phase === "pulling";

  return (
    <div className={cx("rounded-xl border-2 border-dashed p-5 transition-colors duration-150", "border-[var(--color-line-strong)] bg-[var(--color-surface)]")}>
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-[var(--color-surface-sunken)] p-2 text-[var(--color-ink-soft)]">
          <Plug size={17} strokeWidth={2} aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold text-[var(--color-ink)]">Connect to Tally</h3>
          <p className="mt-1 text-[12.5px] leading-snug text-[var(--color-ink-muted)]">
            Pulls the purchase register straight out of TallyPrime over your local network — no
            monthly export. GSTR-2B still needs the portal download; the government gates that behind
            an OTP login this app cannot and should not automate.
          </p>

          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--color-ink-faint)]">
                Tally address
              </span>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={busy || disabled}
                placeholder={DEFAULT_URL}
                className="h-9 w-52 rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 text-[12.5px] text-[var(--color-ink)]"
              />
            </label>
            <Button
              size="sm"
              icon={phase === "probing" ? Loader2 : RefreshCw}
              onClick={testConnection}
              disabled={busy || disabled}
            >
              {phase === "connected" ? "Reconnect" : "Test connection"}
            </Button>
          </div>

          {(phase === "connected" || phase === "pulling") && (
            <div className="mt-4 space-y-3 border-t border-[var(--color-line)] pt-4">
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-[var(--color-good)]">
                <CheckCircle2 size={14} strokeWidth={2} aria-hidden />
                Connected — {companies.length} compan{companies.length === 1 ? "y" : "ies"} open in Tally
              </div>

              <div className="flex flex-wrap items-end gap-2">
                <label className="flex flex-col gap-1">
                  <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--color-ink-faint)]">
                    Company
                  </span>
                  <select
                    value={company}
                    onChange={(e) => setCompany(e.target.value)}
                    disabled={busy}
                    className="h-9 w-56 cursor-pointer rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2.5 text-[12.5px] text-[var(--color-ink)]"
                  >
                    {companies.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--color-ink-faint)]">
                    From
                  </span>
                  <input
                    type="date"
                    value={fromDate}
                    onChange={(e) => setFromDate(e.target.value)}
                    disabled={busy}
                    className="h-9 rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2.5 text-[12.5px] text-[var(--color-ink)]"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--color-ink-faint)]">
                    To
                  </span>
                  <input
                    type="date"
                    value={toDate}
                    onChange={(e) => setToDate(e.target.value)}
                    disabled={busy}
                    className="h-9 rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2.5 text-[12.5px] text-[var(--color-ink)]"
                  />
                </label>
                <Button
                  size="sm"
                  variant="primary"
                  icon={phase === "pulling" ? Loader2 : Plug}
                  onClick={pullRegister}
                  disabled={busy || !company}
                >
                  Pull register
                </Button>
              </div>
            </div>
          )}

          {error && (
            <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-[var(--color-danger-line)] bg-[var(--color-danger-bg)] px-3.5 py-3">
              <AlertCircle size={15} strokeWidth={2} className="mt-0.5 shrink-0 text-[var(--color-danger)]" aria-hidden />
              <div className="min-w-0 text-[12.5px] leading-snug">
                <div className="font-semibold text-[var(--color-danger)]">{error.message}</div>
                <div className="mt-1 text-[var(--color-ink-soft)]">{error.hint}</div>
              </div>
            </div>
          )}

          {result && (
            <div className="mt-4 rounded-lg border border-[var(--color-good-line)] bg-[var(--color-good-bg)] px-3.5 py-3 text-[12.5px] leading-snug text-[var(--color-ink-soft)]">
              <div className="font-semibold text-[var(--color-good)]">
                Pulled {result.records} invoice{result.records === 1 ? "" : "s"} from {result.vouchersSeen}{" "}
                voucher{result.vouchersSeen === 1 ? "" : "s"}
              </div>
              <div className="mt-1">
                {result.gstinsFilled > 0 && <>{result.gstinsFilled} GSTIN{result.gstinsFilled === 1 ? "" : "s"} recovered from ledger masters. </>}
                {result.bankDetailsFound > 0
                  ? `Bank details found for ${result.bankDetailsFound} supplier${result.bankDetailsFound === 1 ? "" : "s"} — the payment file will pre-fill these.`
                  : "No bank details found on the ledger masters — the payment file will ask for these manually."}
              </div>
              {result.warnings > 0 && (
                <div className="mt-1 text-[var(--color-warn)]">
                  {result.warnings} voucher{result.warnings === 1 ? "" : "s"} raised a warning — check
                  the imported register before relying on it.
                </div>
              )}
              {result.truncated && (
                <div className="mt-1 font-semibold text-[var(--color-danger)]">
                  Tally cut the response short — this import is incomplete. Pull a shorter date range.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
