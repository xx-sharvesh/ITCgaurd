/**
 * GSTR-2B parser.
 *
 * Reads the JSON the taxpayer downloads from the GST portal
 * (Returns → GSTR-2B → Download → JSON). The portal's shape is:
 *
 *   { data: { rtnprd, gstin, docdata: { b2b: [supplier…], cdnr: [supplier…] } } }
 *
 * where each supplier block carries `ctin` (their GSTIN), `trdnm` (trade name),
 * `supfildt`/`supprd` (when and for which period they filed), and an array of
 * documents. Each document usually carries an `items` array split by tax rate,
 * which we aggregate — the reconciliation happens at document level because
 * that is the level at which credit is claimed and denied.
 *
 * Defensive throughout: this file is uploaded by a user, may be from a
 * different portal version, and may be an entirely different JSON that they
 * picked by mistake. We never throw on shape; we collect problems and report
 * them, because a stack trace in front of a CFO ends the trial.
 */

import type { DocumentType, GSTR2BRecord, SupplyType, TaxAmounts } from "../domain/types";
import { parsePaise, rupeesToPaise } from "../domain/money";
import { normalizeGstin } from "../domain/gstin";
import { parseGstDate } from "../domain/normalize";

export interface ParseIssue {
  severity: "ERROR" | "WARNING";
  where: string;
  message: string;
}

export interface Gstr2bParseResult {
  records: GSTR2BRecord[];
  issues: ParseIssue[];
  /** Recipient GSTIN the statement was generated for. */
  recipientGstin?: string;
  /** Return period from the file, `MMYYYY`. */
  period?: string;
  /** Portal generation date, if present. */
  generatedOn?: string;
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

/**
 * Read an amount that the portal may emit as a number or a string, in rupees.
 * Returns 0 for absent fields — a missing cess line genuinely means zero cess,
 * unlike a missing invoice number which means the file is wrong.
 */
function amount(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? rupeesToPaise(v) : 0;
  const parsed = parsePaise(v);
  return parsed ?? 0;
}

export function parseGstr2b(input: unknown): Gstr2bParseResult {
  const issues: ParseIssue[] = [];
  const records: GSTR2BRecord[] = [];

  let root: Json | null = null;
  if (typeof input === "string") {
    try {
      root = JSON.parse(input) as Json;
    } catch {
      return {
        records: [],
        issues: [{ severity: "ERROR", where: "file", message: "This is not valid JSON. Download the GSTR-2B JSON again from the portal, or upload the Excel version instead." }],
      };
    }
  } else if (isObject(input)) {
    root = input;
  }

  if (!root) {
    return {
      records: [],
      issues: [{ severity: "ERROR", where: "file", message: "Unrecognised file contents." }],
    };
  }

  // The portal nests everything under `data`; some third-party exports flatten
  // it. Accept both rather than making the user care which they have.
  const data = isObject(root.data) ? root.data : root;
  const docdata = isObject(data.docdata) ? data.docdata : isObject(root.docdata) ? root.docdata : null;

  if (!docdata) {
    return {
      records: [],
      issues: [{
        severity: "ERROR",
        where: "file",
        message: "No `docdata` section found. This looks like valid JSON but not a GSTR-2B download — check you did not pick the GSTR-2A or GSTR-1 file.",
      }],
    };
  }

  const recipientGstin = str(data.gstin) || undefined;
  const period = str(data.rtnprd) || undefined;
  const generatedOn = str(data.gendt) || undefined;

  let seq = 0;
  const nextId = () => `g${++seq}`;

  // ---- B2B invoices --------------------------------------------------------
  for (const supplierRaw of asArray(docdata.b2b)) {
    if (!isObject(supplierRaw)) continue;
    const supplier = readSupplier(supplierRaw);

    for (const docRaw of asArray(supplierRaw.inv)) {
      if (!isObject(docRaw)) continue;
      const rec = readDocument(docRaw, supplier, "B2B", "INVOICE", issues, nextId, period);
      if (rec) records.push(rec);
    }
  }

  // ---- Credit and debit notes ---------------------------------------------
  // Sign convention: a credit note reduces available credit. The portal
  // reports note amounts as positive magnitudes, so we negate credit notes
  // here and keep debit notes positive. Getting this backwards would overstate
  // available ITC by twice the note value.
  for (const supplierRaw of asArray(docdata.cdnr)) {
    if (!isObject(supplierRaw)) continue;
    const supplier = readSupplier(supplierRaw);

    for (const docRaw of asArray(supplierRaw.nt)) {
      if (!isObject(docRaw)) continue;
      const noteType = str(docRaw.ntty).toUpperCase() || str(docRaw.typ).toUpperCase();
      const docType: DocumentType = noteType.startsWith("D") ? "DEBIT_NOTE" : "CREDIT_NOTE";
      const rec = readDocument(docRaw, supplier, "CDNR", docType, issues, nextId, period);
      if (!rec) continue;

      if (docType === "CREDIT_NOTE") {
        rec.taxableValue = -Math.abs(rec.taxableValue);
        rec.invoiceValue = -Math.abs(rec.invoiceValue);
        rec.tax = negate(rec.tax);
      }
      records.push(rec);
    }
  }

  // ---- Import of goods -----------------------------------------------------
  // Included because IMPG credit is real credit and leaving it out understates
  // the 2B total, which breaks the control-total tie-out the CA checks first.
  for (const docRaw of asArray(docdata.impg)) {
    if (!isObject(docRaw)) continue;
    const rec = readDocument(
      docRaw,
      { gstin: "", name: "Import of goods (Customs)" },
      "IMPG",
      "INVOICE",
      issues,
      nextId,
      period,
    );
    if (rec) records.push(rec);
  }

  if (records.length === 0) {
    issues.push({
      severity: "WARNING",
      where: "file",
      message: "The file parsed correctly but contains no documents. If you expected inward supplies this period, confirm you downloaded the right month.",
    });
  }

  return { records, issues, recipientGstin, period, generatedOn };
}

interface SupplierInfo {
  gstin: string;
  name: string;
  filedOn?: string;
  filedPeriod?: string;
  /**
   * GSTR-3B filing status. The portal does not carry this in the standard 2B
   * download — it comes from the GSTN filing-status API. Left undefined here
   * rather than assumed, because assuming `true` would silently suppress every
   * Rule 37A finding and hide the exact exposure this product exists to catch.
   */
  gstr3bFiled?: boolean;
}

function readSupplier(raw: Json): SupplierInfo {
  return {
    gstin: normalizeGstin(str(raw.ctin)),
    name: str(raw.trdnm) || str(raw.trdnam) || "Unnamed supplier",
    filedOn: str(raw.supfildt) || undefined,
    filedPeriod: str(raw.supprd) || undefined,
    gstr3bFiled: typeof raw.srctyp === "string" && raw.cfs === "N" ? false : undefined,
  };
}

function readDocument(
  raw: Json,
  supplier: SupplierInfo,
  supplyType: SupplyType,
  docType: DocumentType,
  issues: ParseIssue[],
  nextId: () => string,
  filePeriod?: string,
): GSTR2BRecord | null {
  const number = str(raw.inum) || str(raw.ntnum) || str(raw.boe) || str(raw.docnum);
  const rawDate = raw.idt ?? raw.ntdt ?? raw.boedt ?? raw.docdt;
  const date = parseGstDate(rawDate);

  const where = `${supplier.name} / ${number || "(no number)"}`;

  if (!number) {
    issues.push({ severity: "WARNING", where, message: "Document has no number and was skipped." });
    return null;
  }
  if (!date) {
    issues.push({
      severity: "WARNING",
      where,
      message: `Document date "${str(rawDate)}" could not be read and the document was skipped.`,
    });
    return null;
  }

  const tax = readTax(raw);
  const taxableValue = readTaxable(raw);
  const invoiceValue = amount(raw.val) || taxableValue + tax.igst + tax.cgst + tax.sgst + tax.cess;

  const itcAvailRaw = str(raw.itcavl).toUpperCase();
  const itcAvailable: "Y" | "N" = itcAvailRaw === "N" ? "N" : "Y";

  return {
    id: nextId(),
    supplierGstin: supplier.gstin,
    supplierName: supplier.name,
    invoiceNumber: number,
    invoiceDate: date,
    documentType: docType,
    supplyType,
    taxableValue,
    tax,
    invoiceValue,
    placeOfSupply: str(raw.pos) || undefined,
    reverseCharge: str(raw.rev).toUpperCase() === "Y",
    period: supplier.filedPeriod || filePeriod || "",
    itcAvailable,
    itcUnavailableReason: str(raw.rsn) || undefined,
    supplierFilingPeriod: supplier.filedPeriod,
    supplierGstr3bFiled: supplier.gstr3bFiled,
  };
}

/**
 * Tax may sit at document level, or be split across an `items` array by rate.
 * A single invoice commonly carries both 18% and 28% lines; we sum them,
 * because credit is claimed per document, not per rate.
 */
function readTax(raw: Json): TaxAmounts {
  const items = asArray(raw.items);
  if (items.length > 0) {
    let igst = 0, cgst = 0, sgst = 0, cess = 0;
    for (const itemRaw of items) {
      if (!isObject(itemRaw)) continue;
      igst += amount(itemRaw.igst);
      cgst += amount(itemRaw.cgst);
      sgst += amount(itemRaw.sgst);
      cess += amount(itemRaw.cess);
    }
    return { igst, cgst, sgst, cess };
  }

  return {
    igst: amount(raw.igst),
    cgst: amount(raw.cgst),
    sgst: amount(raw.sgst),
    cess: amount(raw.cess),
  };
}

function readTaxable(raw: Json): number {
  const items = asArray(raw.items);
  if (items.length > 0) {
    let total = 0;
    for (const itemRaw of items) {
      if (isObject(itemRaw)) total += amount(itemRaw.txval);
    }
    if (total !== 0) return total;
  }
  return amount(raw.txval);
}

function negate(t: TaxAmounts): TaxAmounts {
  return {
    igst: -Math.abs(t.igst),
    cgst: -Math.abs(t.cgst),
    sgst: -Math.abs(t.sgst),
    cess: -Math.abs(t.cess),
  };
}
