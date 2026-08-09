"use client";

/**
 * The match explorer.
 *
 * This is the drilldown a CA lives in when they want to verify a number rather
 * than accept it. It exists to be audited, so it shows the engine's reasoning
 * — which tier fired, how confident it was, and exactly which fields disagree
 * — rather than a bare verdict.
 *
 * Rows are paged rather than virtualised. A register of a few thousand lines
 * pages instantly, and paging keeps Ctrl+F working across the visible set,
 * which is how accountants actually search a table.
 */

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { MatchResult, MatchTier, ReconciliationRun } from "@/lib/domain/types";
import { formatINR, totalTax } from "@/lib/domain/money";
import { formatDate } from "@/lib/domain/normalize";
import { MATCH_TIER_LABELS, MATCH_TIER_ORDER } from "@/lib/export/labels";
import { Badge, Card, Money, cx, type Tone } from "./primitives";

const TIER_TONE: Record<MatchTier, Tone> = {
  EXACT: "good",
  TOLERANT: "good",
  MISMATCH: "warn",
  FUZZY: "warn",
  BOOKS_ONLY: "danger",
  GSTR2B_ONLY: "info",
};

const PAGE = 60;

export function MatchExplorer({ run }: { run: ReconciliationRun }) {
  const [tier, setTier] = useState<MatchTier | "ALL">("ALL");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);

  const counts = useMemo(() => {
    const c: Record<string, number> = { ALL: run.matches.length };
    for (const m of run.matches) c[m.tier] = (c[m.tier] ?? 0) + 1;
    return c;
  }, [run.matches]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return run.matches.filter((m) => {
      if (tier !== "ALL" && m.tier !== tier) return false;
      if (!q) return true;
      const rec = m.purchase ?? m.gstr2b;
      return (
        rec?.supplierName.toLowerCase().includes(q) ||
        rec?.supplierGstin.toLowerCase().includes(q) ||
        m.purchase?.invoiceNumber.toLowerCase().includes(q) ||
        m.gstr2b?.invoiceNumber.toLowerCase().includes(q)
      );
    });
  }, [run.matches, tier, query]);

  const visible = rows.slice(0, limit);

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-line)] px-5 py-3.5">
        <div className="flex flex-wrap gap-1.5">
          {(["ALL", ...MATCH_TIER_ORDER] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setTier(t as MatchTier | "ALL");
                setLimit(PAGE);
              }}
              className={cx(
                "cursor-pointer rounded-lg border px-2.5 py-1.5 text-[12px] font-medium transition-colors duration-150",
                tier === t
                  ? "border-[var(--color-navy)] bg-[var(--color-navy)] text-white"
                  : "border-[var(--color-line-strong)] bg-[var(--color-surface)] text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-sunken)]",
              )}
            >
              {t === "ALL" ? "All" : MATCH_TIER_LABELS[t as MatchTier]}
              <span className="ml-1.5 opacity-60">{counts[t] ?? 0}</span>
            </button>
          ))}
        </div>

        <label className="relative">
          <Search
            size={14}
            strokeWidth={2}
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-ink-faint)]"
          />
          <span className="sr-only">Search invoices and suppliers</span>
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setLimit(PAGE);
            }}
            placeholder="Invoice number, supplier, GSTIN"
            className="h-9 w-64 rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] pl-8 pr-3 text-[13px] text-[var(--color-ink)] placeholder:text-[var(--color-ink-faint)]"
          />
        </label>
      </div>

      <div className="scroll-slim overflow-x-auto">
        <table className="w-full min-w-[980px] text-[12.5px]">
          <thead className="sticky top-0 z-10 bg-[var(--color-surface)]">
            <tr className="border-b border-[var(--color-line)] text-left text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[var(--color-ink-muted)]">
              <th className="px-5 py-2.5">Result</th>
              <th className="px-3 py-2.5">Supplier</th>
              <th className="px-3 py-2.5">Books</th>
              <th className="px-3 py-2.5">GSTR-2B</th>
              <th className="px-3 py-2.5 text-right">Book credit</th>
              <th className="px-3 py-2.5 text-right">2B credit</th>
              <th className="px-5 py-2.5">Why</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((m) => (
              <MatchRow key={m.id} match={m} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-[var(--color-line)] px-5 py-3 text-[12.5px] text-[var(--color-ink-muted)]">
        <span>
          Showing {visible.length.toLocaleString("en-IN")} of {rows.length.toLocaleString("en-IN")}
          {tier !== "ALL" && ` ${MATCH_TIER_LABELS[tier].toLowerCase()}`} rows
        </span>
        {limit < rows.length && (
          <button
            type="button"
            onClick={() => setLimit((l) => l + PAGE * 4)}
            className="cursor-pointer font-medium text-[var(--color-ink)] hover:text-[var(--color-gold)]"
          >
            Load more
          </button>
        )}
      </div>
    </Card>
  );
}

function MatchRow({ match: m }: { match: MatchResult }) {
  const bookCredit = m.purchase ? totalTax(m.purchase.tax) : null;
  const portalCredit = m.gstr2b ? totalTax(m.gstr2b.tax) : null;
  const rec = m.purchase ?? m.gstr2b;

  return (
    <tr className="border-b border-[var(--color-line-hair)] align-top last:border-0 hover:bg-[var(--color-surface-sunken)]">
      <td className="px-5 py-2.5">
        <Badge tone={TIER_TONE[m.tier]} showIcon={false}>
          {MATCH_TIER_LABELS[m.tier]}
        </Badge>
        {m.tier !== "EXACT" && (
          <div className="tnum mt-1 text-[10.5px] text-[var(--color-ink-muted)]">
            {(m.confidence * 100).toFixed(0)}% confident
          </div>
        )}
      </td>

      <td className="px-3 py-2.5">
        <div className="font-medium text-[var(--color-ink)]">{rec?.supplierName}</div>
        <div className="font-mono text-[10.5px] text-[var(--color-ink-muted)]">
          {rec?.supplierGstin}
        </div>
      </td>

      <td className="px-3 py-2.5">
        {m.purchase ? (
          <>
            <div className="font-mono text-[11.5px] text-[var(--color-ink)]">
              {m.purchase.invoiceNumber}
            </div>
            <div className="text-[11px] text-[var(--color-ink-muted)]">
              {formatDate(m.purchase.invoiceDate)}
            </div>
          </>
        ) : (
          <span className="text-[var(--color-ink-faint)]">not booked</span>
        )}
      </td>

      <td className="px-3 py-2.5">
        {m.gstr2b ? (
          <>
            <div className="font-mono text-[11.5px] text-[var(--color-ink)]">
              {m.gstr2b.invoiceNumber}
            </div>
            <div className="text-[11px] text-[var(--color-ink-muted)]">
              {formatDate(m.gstr2b.invoiceDate)}
              {m.gstr2b.itcAvailable === "N" && (
                <span className="ml-1.5 font-semibold text-[var(--color-danger)]">ineligible</span>
              )}
            </div>
          </>
        ) : (
          <span className="text-[var(--color-ink-faint)]">not reported</span>
        )}
      </td>

      <td className="px-3 py-2.5 text-right">
        {bookCredit === null ? (
          <span className="text-[var(--color-ink-faint)]">—</span>
        ) : (
          <Money size="sm">{formatINR(bookCredit)}</Money>
        )}
      </td>

      <td className="px-3 py-2.5 text-right">
        {portalCredit === null ? (
          <span className="text-[var(--color-ink-faint)]">—</span>
        ) : (
          <Money size="sm">{formatINR(portalCredit)}</Money>
        )}
      </td>

      <td className="max-w-sm px-5 py-2.5">
        <div className="text-[11.5px] leading-snug text-[var(--color-ink-soft)]">
          {m.reasons.filter(Boolean).slice(0, 2).join(" · ")}
        </div>
        {m.deltas.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {m.deltas.map((d, i) => (
              <span
                key={i}
                className="rounded border border-[var(--color-warn-line)] bg-[var(--color-warn-bg)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-warn)]"
              >
                {d.field}
                {d.deltaPaise !== undefined && ` ${d.deltaPaise > 0 ? "+" : ""}${formatINR(d.deltaPaise)}`}
              </span>
            ))}
          </div>
        )}
      </td>
    </tr>
  );
}
