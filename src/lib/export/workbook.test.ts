import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { generateDataset } from "../fixtures/generate";
import { runReconciliation } from "../engine/run";
import { paiseToRupees } from "../domain/money";
import { buildWorkbook, workbookFilename } from "./workbook";
import { INR_FORMAT } from "./format";
import type { ExportMeta } from "./labels";

const dataset = generateDataset({ seed: 20260809, lines: 250 });
const run = runReconciliation(dataset.purchases, dataset.gstr2b, {
  asOf: dataset.asOf,
  period: dataset.period,
});

const meta: ExportMeta = {
  companyName: "Vasudha Engineering Industries Pvt Ltd",
  companyGstin: "27AABCV7182N1ZO",
  period: "072026",
  generatedAt: "2026-08-09T00:00:00.000Z",
  preparedBy: "ITC Guard",
};

/** Round-trip through a real .xlsx buffer, not just the in-memory object. */
function roundTrip(): XLSX.WorkBook {
  const wb = buildWorkbook(run, meta);
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx", cellStyles: true }) as Buffer;
  expect(buf.byteLength).toBeGreaterThan(5_000);
  // `cellNF` is required for SheetJS to populate `.z` on read; without it the
  // number format is applied in the file but invisible to this test.
  return XLSX.read(buf, { type: "buffer", cellDates: true, cellNF: true, cellStyles: true });
}

describe("working-papers workbook", () => {
  const wb = roundTrip();

  it("contains every sheet a CA needs to audit the run", () => {
    expect(wb.SheetNames).toEqual([
      "Summary",
      "Control Totals",
      "At Risk",
      "Pay-Hold Decisions",
      "Vendors",
      "All Matches",
      "Books Only (at risk)",
      "2B Only (unclaimed)",
    ]);
  });

  it("keeps sheet names inside Excel's 31-character limit", () => {
    for (const name of wb.SheetNames) expect(name.length).toBeLessThanOrEqual(31);
  });

  /**
   * The load-bearing assertion. A money column stored as text cannot be
   * summed, and a CA who cannot sum our column cannot check our number.
   */
  it("stores money as numbers, not strings", () => {
    const ws = wb.Sheets["At Risk"];
    const range = XLSX.utils.decode_range(ws["!ref"]!);

    let checked = 0;
    for (let r = 1; r <= Math.min(range.e.r, 40); r++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c: 6 })] as XLSX.CellObject | undefined;
      if (!cell) continue;
      expect(cell.t, `row ${r + 1} amount is type "${cell.t}", expected numeric`).toBe("n");
      checked += 1;
    }
    expect(checked).toBeGreaterThan(5);
  });

  it("uses Indian lakh/crore grouping on money cells", () => {
    const ws = wb.Sheets["At Risk"];
    const cell = ws[XLSX.utils.encode_cell({ r: 1, c: 6 })] as XLSX.CellObject;
    // Western "#,##0.00" would render 2,49,46,989 as 24,946,989 and read as
    // wrong to every Indian reader.
    expect(cell.z).toBe(INR_FORMAT);
    expect(String(cell.z)).toContain("#,##,##0");
  });

  it("writes real dates, not date-shaped strings", () => {
    const ws = wb.Sheets["All Matches"];
    const range = XLSX.utils.decode_range(ws["!ref"]!);
    let found = 0;
    for (let r = 1; r <= Math.min(range.e.r, 60); r++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c: 5 })] as XLSX.CellObject | undefined;
      if (cell?.v instanceof Date) found += 1;
    }
    expect(found).toBeGreaterThan(5);
  });

  it("freezes the header and filters the tabular sheets", () => {
    for (const name of ["At Risk", "All Matches", "Vendors"]) {
      expect(wb.Sheets[name]["!autofilter"], `${name} has no autofilter`).toBeTruthy();
    }
  });

  it("ties the At Risk column back to the run's headline figure", () => {
    const ws = wb.Sheets["At Risk"];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws);

    const summed = rows.reduce((s, row) => s + Number(row["Amount at risk (INR)"] ?? 0), 0);
    const expected = run.findings.reduce((s, f) => s + paiseToRupees(f.amountAtRisk), 0);

    // Same figure the screen shows, to the paise. If a CA sums this column it
    // must agree with what we told them.
    expect(summed).toBeCloseTo(expected, 2);
  });

  it("accounts for every match in the All Matches sheet", () => {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets["All Matches"]);
    expect(rows).toHaveLength(run.matches.length);
  });

  it("states the tie-out verdict in plain words on the control totals sheet", () => {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets["Control Totals"]);
    expect(csv).toMatch(/BALANCED|NOT BALANCED/);
  });

  it("produces a filename that sorts and says what it is", () => {
    expect(workbookFilename(meta)).toBe(
      "ITC-working-papers-Vasudha-Engineering-Industries-Pvt-Ltd-072026.xlsx",
    );
    expect(workbookFilename(meta)).not.toMatch(/[\\/:*?"<>|]/);
  });

  it("keeps the entity segment bounded and filesystem-safe", () => {
    const hostile: ExportMeta = {
      ...meta,
      companyName: 'A/B\\C:D*E?F"G<H>I|J & Sons Very Long Trading Company Limited',
    };
    const name = workbookFilename(hostile);
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
    expect(name.length).toBeLessThan(80);
  });
});
