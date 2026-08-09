/**
 * Purchase register parser — Excel and CSV.
 *
 * The file we are handed is whatever the client's accounts team exports. It
 * commonly has a company name in row 1, a period in row 2, a blank row, then
 * the real headers in row 4, then data, then a totals row at the bottom that
 * must not be read as an invoice. All of that is handled here so the user
 * uploads the file they already have rather than reformatting it for us.
 */

import * as XLSX from "xlsx";
import type { DocumentType, MsmeStatus, PurchaseRecord, TaxAmounts } from "../domain/types";
import { parsePaise } from "../domain/money";
import { normalizeGstin, validateGstin } from "../domain/gstin";
import { parseGstDate } from "../domain/normalize";
import { detectColumns, type ColumnMapping, type FieldKey } from "./columns";
import type { ParseIssue } from "./gstr2b";

export interface RegisterParseResult {
  records: PurchaseRecord[];
  issues: ParseIssue[];
  mapping: ColumnMapping;
  /** Zero-based index of the row we treated as headers. */
  headerRowIndex: number;
  /** Rows we read but could not turn into a record. */
  skippedRows: number;
  sheetName: string;
  /** All sheet names, so the UI can offer a different one. */
  availableSheets: string[];
}

export interface RegisterParseOptions {
  /** Force a sheet. Defaults to the first sheet that looks like a register. */
  sheetName?: string;
  /** Override the detected mapping (user corrected it in the UI). */
  mappingOverride?: Partial<Record<FieldKey, number>>;
  /** Override the detected header row. */
  headerRowIndex?: number;
}

type Cell = unknown;
type Row = Cell[];

export function parseRegisterWorkbook(
  input: ArrayBuffer | Uint8Array | string,
  options: RegisterParseOptions = {},
): RegisterParseResult {
  const issues: ParseIssue[] = [];

  let wb: XLSX.WorkBook;
  try {
    wb = typeof input === "string"
      ? XLSX.read(input, { type: "string", cellDates: true, raw: false })
      : XLSX.read(input, { type: "array", cellDates: true, raw: false });
  } catch (err) {
    return emptyResult(
      [{ severity: "ERROR", where: "file", message: `Could not open this file as a spreadsheet. ${errText(err)}` }],
    );
  }

  const availableSheets = wb.SheetNames;
  if (availableSheets.length === 0) {
    return emptyResult([{ severity: "ERROR", where: "file", message: "The workbook has no sheets." }]);
  }

  const sheetName = options.sheetName && availableSheets.includes(options.sheetName)
    ? options.sheetName
    : pickSheet(wb, availableSheets);

  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Row>(sheet, { header: 1, blankrows: false, defval: null });

  if (rows.length === 0) {
    return emptyResult(
      [{ severity: "ERROR", where: sheetName, message: `Sheet "${sheetName}" is empty.` }],
      sheetName,
      availableSheets,
    );
  }

  const headerRowIndex = options.headerRowIndex ?? findHeaderRow(rows);
  const headerRow = rows[headerRowIndex] ?? [];
  const detected = detectColumns(headerRow);

  const mapping: ColumnMapping = options.mappingOverride
    ? { ...detected, map: { ...detected.map, ...options.mappingOverride } }
    : detected;

  if (mapping.missing.length > 0) {
    issues.push({
      severity: "ERROR",
      where: `${sheetName} row ${headerRowIndex + 1}`,
      message: `Could not find these required columns: ${mapping.missing.join(", ")}. Map them manually to continue.`,
    });
    return { records: [], issues, mapping, headerRowIndex, skippedRows: 0, sheetName, availableSheets };
  }

  if (mapping.confidence < 0.8) {
    issues.push({
      severity: "WARNING",
      where: sheetName,
      message: `Column detection is only ${Math.round(mapping.confidence * 100)}% confident. Check the mapping before relying on the result.`,
    });
  }

  const records: PurchaseRecord[] = [];
  let skippedRows = 0;
  let seq = 0;

  for (let r = headerRowIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => c === null || c === undefined || String(c).trim() === "")) continue;

    // Totals and subtotal rows carry a label in one of the text columns and no
    // GSTIN. Reading one as an invoice would double the register.
    if (looksLikeTotalRow(row, mapping)) continue;

    const parsed = readRow(row, mapping, r, () => `p${++seq}`);
    if ("error" in parsed) {
      skippedRows += 1;
      issues.push({ severity: "WARNING", where: `${sheetName} row ${r + 1}`, message: parsed.error });
      continue;
    }
    records.push(parsed.record);
  }

  if (records.length === 0 && skippedRows === 0) {
    issues.push({
      severity: "ERROR",
      where: sheetName,
      message: "No data rows found below the header. Check whether the register is on a different sheet.",
    });
  }

  return { records, issues, mapping, headerRowIndex, skippedRows, sheetName, availableSheets };
}

// ---------------------------------------------------------------------------
// Row reading
// ---------------------------------------------------------------------------

function readRow(
  row: Row,
  mapping: ColumnMapping,
  rowIndex: number,
  nextId: () => string,
): { record: PurchaseRecord } | { error: string } {
  const get = (field: FieldKey): Cell => {
    const col = mapping.map[field];
    return col === undefined ? null : row[col];
  };

  const rawGstin = String(get("supplierGstin") ?? "").trim();
  const gstin = normalizeGstin(rawGstin);
  const invoiceNumber = String(get("invoiceNumber") ?? "").trim();
  const invoiceDate = parseGstDate(get("invoiceDate"));

  if (!invoiceNumber) return { error: "No invoice number in this row." };
  if (!invoiceDate) {
    return { error: `Invoice date "${String(get("invoiceDate") ?? "")}" could not be read.` };
  }

  const taxableValue = parsePaise(get("taxableValue"));
  if (taxableValue === null) {
    return { error: `Taxable value "${String(get("taxableValue") ?? "")}" could not be read as an amount.` };
  }

  const tax: TaxAmounts = {
    igst: parsePaise(get("igst")) ?? 0,
    cgst: parsePaise(get("cgst")) ?? 0,
    sgst: parsePaise(get("sgst")) ?? 0,
    cess: parsePaise(get("cess")) ?? 0,
  };

  // Some registers carry only a rate column and no tax amounts. Deriving the
  // tax lets those files work, but we cannot know the intra/inter-state split
  // without the place of supply, so we compare supplier state to the recorded
  // POS and fall back to IGST when unknown — and flag it in the record.
  const noTaxRecorded = tax.igst === 0 && tax.cgst === 0 && tax.sgst === 0 && tax.cess === 0;
  if (noTaxRecorded) {
    const rate = Number(String(get("rate") ?? "").replace(/[^0-9.]/g, ""));
    if (Number.isFinite(rate) && rate > 0) {
      const total = Math.round((taxableValue * rate) / 100);
      const pos = String(get("placeOfSupply") ?? "").padStart(2, "0").slice(0, 2);
      const supplierState = gstin.slice(0, 2);
      const interState = pos && supplierState ? pos !== supplierState : true;
      if (interState) {
        tax.igst = total;
      } else {
        tax.cgst = Math.round(total / 2);
        tax.sgst = total - tax.cgst;
      }
    }
  }

  const invoiceValue = parsePaise(get("invoiceValue"))
    ?? taxableValue + tax.igst + tax.cgst + tax.sgst + tax.cess;

  const record: PurchaseRecord = {
    id: nextId(),
    supplierGstin: gstin || rawGstin,
    supplierName: String(get("supplierName") ?? "").trim() || "Unnamed supplier",
    invoiceNumber,
    invoiceDate,
    documentType: readDocType(get("documentType")),
    taxableValue,
    tax,
    invoiceValue,
    placeOfSupply: String(get("placeOfSupply") ?? "").trim() || undefined,
    reverseCharge: readBoolean(get("reverseCharge")),
    paymentDate: parseGstDate(get("paymentDate")) ?? undefined,
    msmeStatus: readMsme(get("msmeStatus")),
    sourceRow: rowIndex + 1,
  };

  // A credit note recorded as a positive amount inverts the credit. Registers
  // are inconsistent about this, so normalise on the document type, which is
  // the more reliable signal of the two.
  if (record.documentType === "CREDIT_NOTE" && record.taxableValue > 0) {
    record.taxableValue = -record.taxableValue;
    record.invoiceValue = -Math.abs(record.invoiceValue);
    record.tax = {
      igst: -Math.abs(record.tax.igst),
      cgst: -Math.abs(record.tax.cgst),
      sgst: -Math.abs(record.tax.sgst),
      cess: -Math.abs(record.tax.cess),
    };
  }

  return { record };
}

function readDocType(cell: Cell): DocumentType {
  const s = String(cell ?? "").toLowerCase();
  if (s.includes("credit")) return "CREDIT_NOTE";
  if (s.includes("debit")) return "DEBIT_NOTE";
  return "INVOICE";
}

function readBoolean(cell: Cell): boolean {
  const s = String(cell ?? "").trim().toLowerCase();
  return s === "y" || s === "yes" || s === "true" || s === "1";
}

function readMsme(cell: Cell): MsmeStatus {
  const s = String(cell ?? "").trim().toUpperCase();
  if (!s) return "UNKNOWN";
  if (s.includes("MICRO")) return "MICRO";
  if (s.includes("SMALL")) return "SMALL";
  if (s.includes("MEDIUM")) return "MEDIUM";
  if (s === "N" || s === "NO" || s.includes("NOT")) return "NOT_MSME";
  return "UNKNOWN";
}

// ---------------------------------------------------------------------------
// Sheet and header discovery
// ---------------------------------------------------------------------------

/** Prefer a sheet whose name suggests a purchase register over sheet 1. */
function pickSheet(wb: XLSX.WorkBook, names: string[]): string {
  const preferred = names.find((n) => /purchase|inward|b2b|register|itc/i.test(n));
  if (preferred) return preferred;

  // Otherwise the sheet with the most rows — title and index sheets are short.
  let best = names[0];
  let bestRows = -1;
  for (const n of names) {
    const ref = wb.Sheets[n]?.["!ref"];
    if (!ref) continue;
    const range = XLSX.utils.decode_range(ref);
    const rows = range.e.r - range.s.r;
    if (rows > bestRows) {
      bestRows = rows;
      best = n;
    }
  }
  return best;
}

/**
 * The header row is the one whose cells look most like column names.
 * Scanning the first 25 rows covers the title/period/blank preamble that
 * almost every exported register carries.
 */
function findHeaderRow(rows: Row[]): number {
  let bestIndex = 0;
  let bestScore = -1;

  const limit = Math.min(rows.length, 25);
  for (let i = 0; i < limit; i++) {
    const row = rows[i];
    if (!row) continue;
    const detected = detectColumns(row);
    const filled = row.filter((c) => c !== null && String(c).trim() !== "").length;

    // Require breadth as well as recognisability, so a single stray cell
    // reading "Date" in the title block does not win.
    const score = detected.confidence * 100 + Math.min(filled, 15);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  return bestIndex;
}

function looksLikeTotalRow(row: Row, mapping: ColumnMapping): boolean {
  const gstinCol = mapping.map.supplierGstin;
  const invoiceCol = mapping.map.invoiceNumber;

  const gstin = gstinCol === undefined ? "" : String(row[gstinCol] ?? "").trim();
  const invoice = invoiceCol === undefined ? "" : String(row[invoiceCol] ?? "").trim();

  if (gstin || invoice) {
    // A real row has at least one identifier. But guard the common case where
    // the label "Total" lands in the invoice-number column.
    return /^(grand\s+)?totals?$/i.test(invoice) && !gstin;
  }

  // No identifiers at all but some numbers present → a totals line.
  return row.some((c) => c !== null && String(c).trim() !== "");
}

// ---------------------------------------------------------------------------

function emptyResult(
  issues: ParseIssue[],
  sheetName = "",
  availableSheets: string[] = [],
): RegisterParseResult {
  return {
    records: [],
    issues,
    mapping: { map: {}, matchedHeaders: {}, missing: [], unmapped: [], confidence: 0 },
    headerRowIndex: 0,
    skippedRows: 0,
    sheetName,
    availableSheets,
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Validate GSTINs across a parsed register and report the bad ones. */
export function auditGstins(records: PurchaseRecord[]): ParseIssue[] {
  const issues: ParseIssue[] = [];
  const reported = new Set<string>();

  for (const r of records) {
    const v = validateGstin(r.supplierGstin);
    if (v.valid || reported.has(r.supplierGstin)) continue;
    reported.add(r.supplierGstin);
    issues.push({
      severity: "WARNING",
      where: `${r.supplierName} (${r.supplierGstin || "blank"})`,
      message: `GSTIN fails validation — ${v.error === "BAD_CHECKSUM" ? "the check digit is wrong, which almost always means a typo in the register" : "it is not a well-formed GSTIN"}. Reconciliation for this supplier will not work until it is corrected.`,
    });
  }

  return issues;
}
