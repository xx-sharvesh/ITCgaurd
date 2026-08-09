/**
 * The working-papers workbook.
 *
 * This is the artefact that decides whether a Chartered Accountant trusts the
 * product. They will not audit a web page; they will open this in Excel, tie
 * the control totals back to the two source files, sum a column to check it
 * against our stated figure, and only then read the findings.
 *
 * Three rules follow from that:
 *   1. Money cells are NUMBERS, never strings. A column that cannot be summed
 *      is a column that cannot be checked.
 *   2. Indian grouping. `#,##,##0.00` puts the separators at lakh and crore.
 *      Western `#,##0.00` renders ₹2,49,46,989 as ₹24,946,989 and reads as
 *      wrong to every person who will open this file.
 *   3. Nothing is recomputed here. Every figure comes from the domain model
 *      via `paiseToRupees`, so the workbook and the screen cannot disagree.
 */

import * as XLSX from "xlsx";
import type { ReconciliationRun } from "../domain/types";
import { paiseToRupees, totalTax } from "../domain/money";
import {
  MATCH_TIER_LABELS,
  MSME_LABELS,
  RISK_BAND_LABELS,
  RISK_RULES,
  SEVERITY_LABELS,
  VERDICT_LABELS,
  bindingConstraintLabel,
  recommendedActionLabel,
  type ExportMeta,
} from "./labels";
import { INR_FORMAT, INT_FORMAT, excelDate, DATE_FORMAT } from "./format";

type Cell = string | number | Date | null;

interface SheetSpec {
  name: string;
  /** Column headers. */
  headers: string[];
  rows: Cell[][];
  /** Per-column number format, by index. Undefined means General. */
  formats?: Record<number, string>;
  widths: number[];
  /** Freeze the header row and add a filter. Off for the summary sheets. */
  tabular?: boolean;
}

export function buildWorkbook(run: ReconciliationRun, meta: ExportMeta): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  for (const spec of sheets(run, meta)) appendSheet(wb, spec);
  return wb;
}

function sheets(run: ReconciliationRun, meta: ExportMeta): SheetSpec[] {
  return [
    summarySheet(run, meta),
    controlTotalsSheet(run),
    atRiskSheet(run),
    payHoldSheet(run),
    vendorsSheet(run),
    matchesSheet(run),
    oneSidedSheet(run, "BOOKS_ONLY"),
    oneSidedSheet(run, "GSTR2B_ONLY"),
  ];
}

// ---------------------------------------------------------------------------

function summarySheet(run: ReconciliationRun, meta: ExportMeta): SheetSpec {
  const byRule = new Map<string, { count: number; amount: number }>();
  for (const f of run.findings) {
    const cur = byRule.get(f.rule) ?? { count: 0, amount: 0 };
    cur.count += 1;
    cur.amount += f.amountAtRisk;
    byRule.set(f.rule, cur);
  }

  const rows: Cell[][] = [
    ["Entity", meta.companyName, null, null],
    ["GSTIN", meta.companyGstin, null, null],
    ["Return period", meta.period, null, null],
    ["Prepared", meta.generatedAt.slice(0, 10), null, null],
    ["Prepared by", meta.preparedBy ?? "ITC Guard", null, null],
    [null, null, null, null],
    ["Input tax credit at risk", null, null, paiseToRupees(run.totalAtRisk)],
    ["Credit claimed in the register", null, null, paiseToRupees(run.totals.booksItc)],
    ["Lines auto-resolved", null, null, `${(run.autoResolvedRatio * 100).toFixed(1)}%`],
    ["Control totals", null, null, run.totals.balanced ? "BALANCED" : "NOT BALANCED"],
    [null, null, null, null],
    ["Exposure by provision", "Citation", "Documents", "Amount at risk (INR)"],
  ];

  for (const [rule, { count, amount }] of [...byRule].sort((a, b) => b[1].amount - a[1].amount)) {
    const meta_ = RISK_RULES[rule as keyof typeof RISK_RULES];
    rows.push([meta_.label, meta_.citation, count, paiseToRupees(amount)]);
  }

  if (!run.totals.balanced && run.totals.imbalanceNote) {
    rows.push([null, null, null, null]);
    rows.push(["WARNING", run.totals.imbalanceNote, null, null]);
  }

  return {
    name: "Summary",
    headers: ["ITC Guard — reconciliation summary", null as unknown as string, "", ""].map(String),
    rows,
    formats: { 3: INR_FORMAT, 2: INT_FORMAT },
    widths: [38, 46, 12, 22],
  };
}

function controlTotalsSheet(run: ReconciliationRun): SheetSpec {
  const t = run.totals;
  const rows: Cell[][] = [
    ["Purchase register lines", t.booksLineCount, null],
    ["GSTR-2B documents", t.gstr2bLineCount, null],
    [null, null, null],
    ["Credit claimed in the register", null, paiseToRupees(t.booksItc)],
    ["  matched to GSTR-2B", null, paiseToRupees(t.matchedItc)],
    ["  unmatched (books only)", null, paiseToRupees(t.booksOnlyItc)],
    [null, null, null],
    ["Credit available per GSTR-2B", null, paiseToRupees(t.gstr2bItc)],
    ["  not recorded in books", null, paiseToRupees(t.gstr2bOnlyItc)],
    [null, null, null],
    ["Matched + unmatched", null, paiseToRupees(t.matchedItc + t.booksOnlyItc)],
    ["Must equal credit claimed", null, paiseToRupees(t.booksItc)],
    ["Tie-out", t.balanced ? "BALANCED" : "NOT BALANCED", null],
  ];

  if (!t.balanced && t.imbalanceNote) rows.push(["Note", t.imbalanceNote, null]);

  return {
    name: "Control Totals",
    headers: ["Control total", "Count / status", "Amount (INR)"],
    rows,
    formats: { 2: INR_FORMAT },
    widths: [42, 20, 22],
  };
}

function atRiskSheet(run: ReconciliationRun): SheetSpec {
  return {
    name: "At Risk",
    headers: [
      "Provision", "Citation", "Severity", "Supplier", "GSTIN",
      "Finding", "Amount at risk (INR)", "Deadline", "Recommended action",
    ],
    rows: run.findings.map((f) => [
      RISK_RULES[f.rule].label,
      f.citation,
      SEVERITY_LABELS[f.severity],
      f.supplierName,
      f.supplierGstin,
      f.headline,
      paiseToRupees(f.amountAtRisk),
      f.deadline ? excelDate(f.deadline) : null,
      recommendedActionLabel(f.recommendedAction),
    ]),
    formats: { 6: INR_FORMAT, 7: DATE_FORMAT },
    widths: [26, 42, 11, 32, 18, 66, 20, 13, 20],
    tabular: true,
  };
}

function payHoldSheet(run: ReconciliationRun): SheetSpec {
  return {
    name: "Pay-Hold Decisions",
    headers: [
      "Supplier", "GSTIN", "Verdict", "Balance outstanding (INR)",
      "Cost of paying (INR)", "Cost of holding (INR)", "Binding constraint",
      "Decide by", "Open invoices", "Rationale",
    ],
    rows: run.decisions.map((d) => [
      d.supplierName,
      d.supplierGstin,
      VERDICT_LABELS[d.verdict],
      paiseToRupees(d.exposure),
      paiseToRupees(d.costOfPaying),
      paiseToRupees(d.costOfHolding),
      bindingConstraintLabel(d.bindingConstraint),
      d.decideBy ? excelDate(d.decideBy) : null,
      d.matchIds.length,
      d.rationale.join(" "),
    ]),
    formats: { 3: INR_FORMAT, 4: INR_FORMAT, 5: INR_FORMAT, 7: DATE_FORMAT, 8: INT_FORMAT },
    widths: [32, 18, 18, 22, 20, 20, 26, 13, 14, 90],
    tabular: true,
  };
}

function vendorsSheet(run: ReconciliationRun): SheetSpec {
  return {
    name: "Vendors",
    headers: [
      "Supplier", "GSTIN", "GSTIN valid", "MSME status", "Risk band", "Risk score",
      "Credit relied on (INR)", "At risk (INR)", "Invoices",
      "Periods with a miss", "Periods observed",
    ],
    rows: run.vendors.map((v) => [
      v.name,
      v.gstin,
      v.gstinValid ? "Yes" : "No",
      MSME_LABELS[v.msmeStatus],
      RISK_BAND_LABELS[v.riskBand],
      v.riskScore,
      paiseToRupees(v.itcExposure),
      paiseToRupees(v.itcAtRisk),
      v.invoiceCount,
      v.missedFilings,
      v.observedPeriods,
    ]),
    formats: { 5: INT_FORMAT, 6: INR_FORMAT, 7: INR_FORMAT, 8: INT_FORMAT, 9: INT_FORMAT, 10: INT_FORMAT },
    widths: [32, 18, 12, 14, 12, 11, 22, 18, 10, 18, 16],
    tabular: true,
  };
}

function matchesSheet(run: ReconciliationRun): SheetSpec {
  return {
    name: "All Matches",
    headers: [
      "Result", "Confidence", "Supplier", "GSTIN",
      "Books invoice", "Books date", "Books taxable (INR)", "Books credit (INR)",
      "2B invoice", "2B date", "2B taxable (INR)", "2B credit (INR)",
      "Credit difference (INR)", "ITC eligible per 2B", "Reason", "Fields differing",
    ],
    rows: run.matches.map((m) => {
      const rec = m.purchase ?? m.gstr2b;
      return [
        MATCH_TIER_LABELS[m.tier],
        m.confidence,
        rec?.supplierName ?? "",
        rec?.supplierGstin ?? "",
        m.purchase?.invoiceNumber ?? null,
        m.purchase ? excelDate(m.purchase.invoiceDate) : null,
        m.purchase ? paiseToRupees(m.purchase.taxableValue) : null,
        m.purchase ? paiseToRupees(totalTax(m.purchase.tax)) : null,
        m.gstr2b?.invoiceNumber ?? null,
        m.gstr2b ? excelDate(m.gstr2b.invoiceDate) : null,
        m.gstr2b ? paiseToRupees(m.gstr2b.taxableValue) : null,
        m.gstr2b ? paiseToRupees(totalTax(m.gstr2b.tax)) : null,
        paiseToRupees(m.itcDeltaPaise),
        m.gstr2b ? (m.gstr2b.itcAvailable === "Y" ? "Yes" : "No") : "",
        m.reasons.filter(Boolean).join("; "),
        m.deltas.map((d) => d.field).join(", "),
      ];
    }),
    formats: {
      1: "0.00", 6: INR_FORMAT, 7: INR_FORMAT, 10: INR_FORMAT, 11: INR_FORMAT,
      12: INR_FORMAT, 5: DATE_FORMAT, 9: DATE_FORMAT,
    },
    widths: [18, 11, 30, 18, 22, 12, 20, 20, 22, 12, 20, 20, 22, 18, 60, 24],
    tabular: true,
  };
}

function oneSidedSheet(run: ReconciliationRun, tier: "BOOKS_ONLY" | "GSTR2B_ONLY"): SheetSpec {
  const isBooks = tier === "BOOKS_ONLY";
  const rows = run.matches
    .filter((m) => m.tier === tier)
    .map((m) => {
      const rec = isBooks ? m.purchase! : m.gstr2b!;
      return [
        rec.supplierName,
        rec.supplierGstin,
        rec.invoiceNumber,
        excelDate(rec.invoiceDate),
        rec.documentType,
        paiseToRupees(rec.taxableValue),
        paiseToRupees(totalTax(rec.tax)),
        paiseToRupees(rec.invoiceValue),
      ] as Cell[];
    });

  return {
    // Framed as opportunity rather than error: 2B-only lines are usually
    // credit the client is entitled to and simply has not booked.
    name: isBooks ? "Books Only (at risk)" : "2B Only (unclaimed)",
    headers: [
      "Supplier", "GSTIN", "Invoice", "Date", "Document type",
      "Taxable (INR)", "Credit (INR)", "Invoice value (INR)",
    ],
    rows,
    formats: { 3: DATE_FORMAT, 5: INR_FORMAT, 6: INR_FORMAT, 7: INR_FORMAT },
    widths: [32, 18, 24, 13, 15, 20, 20, 22],
    tabular: true,
  };
}

// ---------------------------------------------------------------------------

function appendSheet(wb: XLSX.WorkBook, spec: SheetSpec): void {
  const aoa: Cell[][] = [spec.headers as Cell[], ...spec.rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });

  const lastRow = aoa.length - 1;
  const lastCol = Math.max(spec.headers.length, ...spec.rows.map((r) => r.length)) - 1;

  ws["!cols"] = spec.widths.map((wch) => ({ wch }));

  if (spec.tabular) {
    // Freeze the header so a CA scrolling row 3,000 still knows the columns,
    // and add a filter so they can isolate a supplier without writing a
    // formula. Both are the first things they would otherwise do by hand.
    ws["!freeze"] = { xSplit: 0, ySplit: 1, topLeftCell: "A2", activePane: "bottomLeft", state: "frozen" };
    ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastRow, c: lastCol } }) };
  }

  // Bold the header row.
  for (let c = 0; c <= lastCol; c++) {
    const ref = XLSX.utils.encode_cell({ r: 0, c });
    const cell = ws[ref] as XLSX.CellObject | undefined;
    if (cell) cell.s = { font: { bold: true } };
  }

  // Apply number formats. Done cell by cell because SheetJS has no concept of
  // a column style, and a format applied to a blank cell would render a
  // spurious "₹0.00" where we deliberately wrote nothing.
  if (spec.formats) {
    for (const [colStr, fmt] of Object.entries(spec.formats)) {
      const c = Number(colStr);
      for (let r = 1; r <= lastRow; r++) {
        const ref = XLSX.utils.encode_cell({ r, c });
        const cell = ws[ref] as XLSX.CellObject | undefined;
        if (!cell || cell.v === null || cell.v === undefined) continue;
        if (cell.t === "n" || cell.t === "d") cell.z = fmt;
      }
    }
  }

  // Excel caps sheet names at 31 characters and forbids : \ / ? * [ ].
  const safe = spec.name.replace(/[:\\/?*[\]]/g, "-").slice(0, 31);
  XLSX.utils.book_append_sheet(wb, ws, safe);
}

/** Filename that sorts chronologically and says what it is. */
export function workbookFilename(meta: ExportMeta): string {
  const entity = meta.companyName.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return `ITC-working-papers-${entity}-${meta.period}.xlsx`;
}
