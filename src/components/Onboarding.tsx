"use client";

/**
 * The way in.
 *
 * This screen is also the wedge. The go-to-market is a free ITC leakage audit:
 * a CFO hands over two files they already have and gets a rupee figure back in
 * minutes. So there is no signup, no account, and no configuration between
 * arriving and seeing the number — every step added here is a step where the
 * trial dies.
 *
 * "Try it on sample data" sits first on purpose. Nobody uploads a purchase
 * ledger to software they have not seen working.
 */

import { useCallback, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  FileJson,
  FileSpreadsheet,
  Loader2,
  Lock,
  Plug,
  PlayCircle,
  Upload,
} from "lucide-react";
import type { BankDetails, GSTR2BRecord, PurchaseRecord } from "@/lib/domain/types";
import { parseGstr2b, type ParseIssue } from "@/lib/parse/gstr2b";
import { auditGstins, parseRegisterWorkbook } from "@/lib/parse/register";
import { DEFAULT_COMPANY, type CompanyProfile } from "@/lib/store/session";
import { Button, Card, cx } from "./primitives";
import { TallyConnect } from "./TallyConnect";

interface LoadedData {
  purchases: PurchaseRecord[];
  gstr2b: GSTR2BRecord[];
  asOf: string;
  period: string;
  company: CompanyProfile;
  sources: { register?: string; portal?: string };
  bankDirectory?: Record<string, BankDetails>;
}

export function Onboarding({
  onLoad,
}: {
  onLoad: (data: LoadedData, opts?: { isSample?: boolean }) => void;
}) {
  const [busy, setBusy] = useState<null | string>(null);
  const [register, setRegister] = useState<{ name: string; records: PurchaseRecord[] } | null>(null);
  const [portal, setPortal] = useState<{ name: string; records: GSTR2BRecord[]; period?: string } | null>(null);
  const [issues, setIssues] = useState<ParseIssue[]>([]);
  const [registerMode, setRegisterMode] = useState<"upload" | "tally">("upload");
  const [bankDirectory, setBankDirectory] = useState<Record<string, BankDetails>>({});

  const registerInput = useRef<HTMLInputElement>(null);
  const portalInput = useRef<HTMLInputElement>(null);

  const runDemo = useCallback(async () => {
    setBusy("Building a realistic 616-line register…");
    // Yield a frame so the button's busy state paints before the generator
    // blocks the main thread.
    await new Promise((r) => setTimeout(r, 30));
    const { generateDataset } = await import("@/lib/fixtures/generate");
    const ds = generateDataset({ seed: 20260809, lines: 600 });
    onLoad(
      {
        purchases: ds.purchases,
        gstr2b: ds.gstr2b,
        asOf: ds.asOf,
        period: ds.period,
        company: DEFAULT_COMPANY,
        sources: { register: "Sample register (616 lines)", portal: "Sample GSTR-2B" },
      },
      { isSample: true },
    );
  }, [onLoad]);

  const handleTallyPulled = useCallback(
    (records: PurchaseRecord[], bank: Record<string, BankDetails>, sourceLabel: string) => {
      setRegister({ name: sourceLabel, records });
      setBankDirectory(bank);
      setIssues((prev) => prev.filter((i) => !i.where.startsWith("register")));
    },
    [],
  );

  const onRegisterFile = useCallback(async (file: File) => {
    setBusy(`Reading ${file.name}…`);
    try {
      const buf = await file.arrayBuffer();
      const result = parseRegisterWorkbook(buf);
      const gstinIssues = auditGstins(result.records);
      setIssues((prev) => [...prev.filter((i) => !i.where.startsWith("register")), ...result.issues, ...gstinIssues]);
      if (result.records.length > 0) {
        setRegister({ name: file.name, records: result.records });
      }
    } catch (err) {
      setIssues((prev) => [
        ...prev,
        { severity: "ERROR", where: file.name, message: err instanceof Error ? err.message : "Could not read this file." },
      ]);
    } finally {
      setBusy(null);
    }
  }, []);

  const onPortalFile = useCallback(async (file: File) => {
    setBusy(`Reading ${file.name}…`);
    try {
      const text = await file.text();
      const result = parseGstr2b(text);
      setIssues((prev) => [...prev, ...result.issues]);
      if (result.records.length > 0) {
        setPortal({ name: file.name, records: result.records, period: result.period });
      }
    } catch (err) {
      setIssues((prev) => [
        ...prev,
        { severity: "ERROR", where: file.name, message: err instanceof Error ? err.message : "Could not read this file." },
      ]);
    } finally {
      setBusy(null);
    }
  }, []);

  const canReconcile = register !== null && portal !== null;

  const reconcile = useCallback(() => {
    if (!register || !portal) return;
    const period = portal.period || inferPeriod(portal.records, register.records);
    onLoad({
      purchases: register.records,
      gstr2b: portal.records,
      // Statutory clocks run from today for a live upload. The engine never
      // reads the clock itself, so the reference date is set once, here.
      asOf: new Date().toISOString().slice(0, 10),
      period,
      company: DEFAULT_COMPANY,
      sources: { register: register.name, portal: portal.name },
      bankDirectory: Object.keys(bankDirectory).length > 0 ? bankDirectory : undefined,
    });
  }, [register, portal, bankDirectory, onLoad]);

  const errors = issues.filter((i) => i.severity === "ERROR");
  const warnings = issues.filter((i) => i.severity === "WARNING");

  return (
    <main className="min-h-dvh">
      <div className="paper border-b border-[var(--color-line)]">
        <div className="mx-auto max-w-[980px] px-6 py-16 lg:px-10 lg:py-24">
          <div className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-[var(--color-navy)] text-[13px] font-bold text-white">
              ₹
            </span>
            <span className="text-[15px] font-semibold tracking-tight text-[var(--color-ink)]">
              ITC Guard
            </span>
          </div>

          <h1 className="mt-10 max-w-3xl text-[clamp(2rem,5vw,3.25rem)] font-semibold leading-[1.08] tracking-[-0.03em] text-[var(--color-ink)]">
            Find out what your GST credit is actually worth.
          </h1>

          <p className="mt-5 max-w-2xl text-[16px] leading-relaxed text-[var(--color-ink-soft)]">
            Hand over your purchase register and your GSTR-2B. In under a minute you will see the
            rupee value of the input tax credit you are about to lose, which supplier is losing it
            for you, and whether to pay them or hold.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button variant="primary" icon={PlayCircle} onClick={runDemo} disabled={busy !== null}>
              Try it on sample data
            </Button>
            <span className="text-[13px] text-[var(--color-ink-muted)]">
              A realistic 616-line register for a mid-size manufacturer. No signup.
            </span>
          </div>

          <div className="mt-10 flex flex-wrap gap-x-8 gap-y-3 border-t border-[var(--color-line)] pt-6">
            <Claim>Sec 16(2)(aa) · credit absent from GSTR-2B</Claim>
            <Claim>Rule 37A · supplier filed GSTR-1 but not GSTR-3B</Claim>
            <Claim>Rule 37 · 180-day payment clock</Claim>
            <Claim>Sec 43B(h) · MSME payment deadline</Claim>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-[980px] px-6 py-14 lg:px-10">
        <div className="mb-6 flex items-start gap-2.5">
          <Lock size={15} strokeWidth={2} className="mt-0.5 shrink-0 text-[var(--color-good)]" aria-hidden />
          <p className="max-w-2xl text-[13.5px] leading-relaxed text-[var(--color-ink-soft)]">
            <strong className="font-semibold text-[var(--color-ink)]">
              Your files never leave this browser.
            </strong>{" "}
            Both are parsed and reconciled locally on this machine, and stored only in this
            browser&rsquo;s own storage. There is no server to upload to.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <div className="mb-2 flex gap-1.5">
              <button
                type="button"
                onClick={() => setRegisterMode("upload")}
                className={cx(
                  "cursor-pointer rounded-md border px-2.5 py-1 text-[11.5px] font-medium transition-colors duration-150",
                  registerMode === "upload"
                    ? "border-[var(--color-navy)] bg-[var(--color-navy)] text-white"
                    : "border-[var(--color-line-strong)] bg-[var(--color-surface)] text-[var(--color-ink-muted)]",
                )}
              >
                Upload a file
              </button>
              <button
                type="button"
                onClick={() => setRegisterMode("tally")}
                className={cx(
                  "inline-flex cursor-pointer items-center gap-1 rounded-md border px-2.5 py-1 text-[11.5px] font-medium transition-colors duration-150",
                  registerMode === "tally"
                    ? "border-[var(--color-navy)] bg-[var(--color-navy)] text-white"
                    : "border-[var(--color-line-strong)] bg-[var(--color-surface)] text-[var(--color-ink-muted)]",
                )}
              >
                <Plug size={11} strokeWidth={2.5} aria-hidden />
                Connect to Tally
              </button>
            </div>

            {registerMode === "upload" ? (
              <DropCard
                icon={FileSpreadsheet}
                title="Purchase register"
                hint="Excel or CSV, exported from Tally, Busy, Zoho or SAP. Columns are detected automatically."
                accept=".xlsx,.xls,.csv"
                loaded={register ? `${register.name} — ${register.records.length} lines` : null}
                inputRef={registerInput}
                onFile={onRegisterFile}
                disabled={busy !== null}
              />
            ) : (
              <TallyConnect onPulled={handleTallyPulled} disabled={busy !== null} />
            )}
          </div>
          <DropCard
            icon={FileJson}
            title="GSTR-2B"
            hint="The JSON download from the GST portal: Returns → GSTR-2B → Download."
            accept=".json"
            loaded={portal ? `${portal.name} — ${portal.records.length} documents` : null}
            inputRef={portalInput}
            onFile={onPortalFile}
            disabled={busy !== null}
          />
        </div>

        {busy && (
          <div className="mt-4 flex items-center gap-2 text-[13px] text-[var(--color-ink-muted)]">
            <Loader2 size={14} strokeWidth={2} className="animate-spin" aria-hidden />
            {busy}
          </div>
        )}

        {(errors.length > 0 || warnings.length > 0) && (
          <Card className="mt-5 overflow-hidden">
            <div className="border-b border-[var(--color-line)] px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-ink-muted)]">
              {errors.length > 0 ? `${errors.length} problem${errors.length === 1 ? "" : "s"}` : "Notes"}
              {warnings.length > 0 && ` · ${warnings.length} warning${warnings.length === 1 ? "" : "s"}`}
            </div>
            <ul className="scroll-slim max-h-64 overflow-y-auto">
              {[...errors, ...warnings].slice(0, 40).map((issue, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2.5 border-b border-[var(--color-line-hair)] px-4 py-2.5 last:border-0"
                >
                  <AlertCircle
                    size={14}
                    strokeWidth={2}
                    aria-hidden
                    className={cx(
                      "mt-0.5 shrink-0",
                      issue.severity === "ERROR"
                        ? "text-[var(--color-danger)]"
                        : "text-[var(--color-warn)]",
                    )}
                  />
                  <div className="min-w-0">
                    <div className="text-[12px] font-medium text-[var(--color-ink)]">{issue.where}</div>
                    <div className="text-[12px] leading-snug text-[var(--color-ink-muted)]">
                      {issue.message}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <div className="mt-6">
          <Button
            variant="primary"
            icon={ArrowRight}
            onClick={reconcile}
            disabled={!canReconcile || busy !== null}
          >
            Reconcile {canReconcile ? `${register.records.length} lines` : ""}
          </Button>
          {!canReconcile && (
            <p className="mt-2 text-[12.5px] text-[var(--color-ink-muted)]">
              Both files are needed. Only have one to hand? Run the sample data above to see the
              output first.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}

function Claim({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 text-[12.5px] text-[var(--color-ink-muted)]">
      <CheckCircle2 size={13} strokeWidth={2} className="shrink-0 text-[var(--color-good)]" aria-hidden />
      {children}
    </span>
  );
}

function DropCard({
  icon: Icon,
  title,
  hint,
  accept,
  loaded,
  inputRef,
  onFile,
  disabled,
}: {
  icon: typeof FileJson;
  title: string;
  hint: string;
  accept: string;
  loaded: string | null;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onFile: (file: File) => void;
  disabled: boolean;
}) {
  const [dragging, setDragging] = useState(false);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files?.[0];
        if (file) onFile(file);
      }}
      className={cx(
        "rounded-xl border-2 border-dashed p-5 transition-colors duration-150",
        dragging
          ? "border-[var(--color-gold)] bg-[var(--color-gold-soft)]"
          : loaded
            ? "border-[var(--color-good-line)] bg-[var(--color-good-bg)]"
            : "border-[var(--color-line-strong)] bg-[var(--color-surface)]",
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cx(
            "rounded-lg p-2",
            loaded ? "bg-[var(--color-good)] text-white" : "bg-[var(--color-surface-sunken)] text-[var(--color-ink-soft)]",
          )}
        >
          {loaded ? (
            <CheckCircle2 size={17} strokeWidth={2} aria-hidden />
          ) : (
            <Icon size={17} strokeWidth={2} aria-hidden />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold text-[var(--color-ink)]">{title}</h3>
          <p className="mt-1 text-[12.5px] leading-snug text-[var(--color-ink-muted)]">
            {loaded ?? hint}
          </p>
          <input
            ref={inputRef}
            type="file"
            accept={accept}
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onFile(file);
              e.target.value = "";
            }}
          />
          <div className="mt-3">
            <Button
              size="sm"
              icon={Upload}
              onClick={() => inputRef.current?.click()}
              disabled={disabled}
            >
              {loaded ? "Replace file" : "Choose file"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function inferPeriod(gstr2b: GSTR2BRecord[], purchases: PurchaseRecord[]): string {
  const fromPortal = gstr2b.find((g) => g.period)?.period;
  if (fromPortal) return fromPortal;
  const date = purchases[0]?.invoiceDate ?? gstr2b[0]?.invoiceDate;
  if (!date) return "";
  const [y, m] = date.split("-");
  return `${m}${y}`;
}
