/**
 * Tally voucher → PurchaseRecord.
 *
 * Tally does not store an invoice the way a purchase register does. It stores
 * a double-entry voucher: one line per ledger, with signs. A ₹1,18,000 purchase
 * at 18% intra-state looks like this:
 *
 *   Shree Balaji Steel Traders   -118000.00   (party, credited)
 *   Purchase - Raw Material       100000.00   (expense, debited)
 *   CGST Input                      9000.00
 *   SGST Input                      9000.00
 *
 * So the taxable value is not a field — it is whatever is left after the tax
 * ledgers are removed from the debit side. We identify tax ledgers by name,
 * because Tally has no machine-readable flag for "this ledger is CGST"; the
 * classification lives in the GST details of the ledger master, which the
 * voucher export does not carry.
 *
 * Nothing is ever silently dropped. A voucher we cannot fully understand comes
 * back as a warning with its number attached, because a missing purchase line
 * is missing credit, and missing credit is the entire problem this product
 * exists to solve.
 */

import type { DocumentType, PurchaseRecord, TaxAmounts } from "../domain/types";
import { parsePaise } from "../domain/money";
import { normalizeGstin } from "../domain/gstin";
import {
  childText,
  collapse,
  findAll,
  parseXmlDocument,
  sanitizeTallyXml,
  type XmlNode,
} from "./xml";
import { fromTallyDate } from "./requests";

export interface TallyWarning {
  /** Voucher number, or a positional label when even that is missing. */
  voucher: string;
  message: string;
}

export interface TallyParseResult {
  records: PurchaseRecord[];
  warnings: TallyWarning[];
  /** Vouchers seen, including those skipped as non-purchase. */
  vouchersSeen: number;
  /**
   * True when the XML ended mid-element. The import is incomplete and its
   * totals must not be trusted.
   */
  truncated: boolean;
  /** Repairs the sanitiser had to make to get the XML to parse. */
  repairs: { kind: string; count: number }[];
}

/**
 * Ledger-name patterns that identify each tax head.
 *
 * Ordered so IGST is tested before GST, and UTGST before SGST — a ledger named
 * "IGST Input" contains the substring "GST" and would otherwise fall through
 * to the wrong head. Matching is on a collapsed uppercase name so
 * "C.G.S.T. Input @ 9%" and "CGST INPUT" land in the same place.
 */
const TAX_PATTERNS: Array<{ head: keyof TaxAmounts; test: RegExp }> = [
  { head: "cess", test: /\bCESS\b/ },
  { head: "igst", test: /\bI\.?\s?G\.?\s?S\.?\s?T\.?\b|INTEGRATED\s+TAX/ },
  { head: "cgst", test: /\bC\.?\s?G\.?\s?S\.?\s?T\.?\b|CENTRAL\s+TAX/ },
  { head: "sgst", test: /\bS\.?\s?G\.?\s?S\.?\s?T\.?\b|\bU\.?\s?T\.?\s?G\.?\s?S\.?\s?T\.?\b|STATE\s+TAX|UNION\s+TERRITORY\s+TAX/ },
];

/** Voucher types we treat as inward supply. Everything else is skipped. */
const PURCHASE_TYPES = /^(PURCHASE|PURC|PURCHASE\s|GST\s*PURCHASE|IMPORT\s*PURCHASE)/;
const CREDIT_NOTE_TYPES = /CREDIT\s*NOTE|CRNOTE|C\s*NOTE/;
const DEBIT_NOTE_TYPES = /DEBIT\s*NOTE|DRNOTE|D\s*NOTE/;

export function parsePurchaseVouchers(rawXml: string): TallyParseResult {
  const warnings: TallyWarning[] = [];
  const records: PurchaseRecord[] = [];

  // Sanitise first. Tally emits bare ampersands in party names and stray
  // control-character entities, both of which are fatal to a strict walk.
  const sanitized = sanitizeTallyXml(rawXml);
  const doc = parseXmlDocument(sanitized.xml);
  const vouchers = findAll(doc.root, "VOUCHER");

  // A truncated export must never be read as "that is all the vouchers there
  // were" — that would silently understate the register, which is the exact
  // failure mode this product exists to prevent.
  if (doc.unclosed.length > 0) {
    warnings.push({
      voucher: "(response)",
      message:
        `The XML ended while ${doc.unclosed.length} element${doc.unclosed.length === 1 ? " was" : "s were"} still open ` +
        `(${doc.unclosed.slice(0, 3).join(", ")}). Tally cut the response short, so this import is INCOMPLETE. ` +
        "Pull a shorter date range and do not rely on these totals.",
    });
  }

  let seq = 0;
  let position = 0;

  for (const voucher of vouchers) {
    position += 1;
    const number =
      childText(voucher, "VOUCHERNUMBER") ||
      childText(voucher, "REFERENCE") ||
      `(voucher ${position})`;

    const typeName = collapse(
      childText(voucher, "VOUCHERTYPENAME") || voucher.attrs.VCHTYPE || "",
    ).toUpperCase();

    const documentType = classify(typeName);
    if (documentType === null) continue; // Not an inward supply; not our concern.

    const parsed = readVoucher(voucher, number, documentType, () => `t${++seq}`);
    if ("error" in parsed) {
      warnings.push({ voucher: number, message: parsed.error });
      continue;
    }

    records.push(parsed.record);
    for (const w of parsed.warnings) warnings.push({ voucher: number, message: w });
  }

  return {
    records,
    warnings,
    vouchersSeen: vouchers.length,
    truncated: doc.unclosed.length > 0,
    repairs: sanitized.repairs.map((r) => ({ kind: r.kind, count: r.count })),
  };
}

function classify(typeName: string): DocumentType | null {
  if (CREDIT_NOTE_TYPES.test(typeName)) return "CREDIT_NOTE";
  if (DEBIT_NOTE_TYPES.test(typeName)) return "DEBIT_NOTE";
  if (PURCHASE_TYPES.test(typeName)) return "INVOICE";
  return null;
}

function readVoucher(
  voucher: XmlNode,
  number: string,
  documentType: DocumentType,
  nextId: () => string,
): { record: PurchaseRecord; warnings: string[] } | { error: string } {
  const warnings: string[] = [];

  const rawDate = childText(voucher, "DATE") || childText(voucher, "EFFECTIVEDATE");
  const invoiceDate = fromTallyDate(rawDate);
  if (!invoiceDate) {
    return { error: `Voucher date "${rawDate}" could not be read; the voucher was not imported.` };
  }

  // The supplier's own invoice number is what appears in GSTR-2B. Tally's
  // VOUCHERNUMBER is the buyer's internal serial and will never match the
  // portal, so REFERENCE (the supplier bill number) is strongly preferred.
  const supplierInvoiceNumber =
    childText(voucher, "REFERENCE") ||
    childText(voucher, "SUPPLIERINVOICENUMBER") ||
    childText(voucher, "VOUCHERNUMBER");

  if (!childText(voucher, "REFERENCE")) {
    warnings.push(
      "No supplier bill reference on this voucher, so Tally's own voucher number was used. " +
        "It will not match GSTR-2B unless the supplier happens to use the same series.",
    );
  }

  const partyName =
    childText(voucher, "PARTYLEDGERNAME") ||
    childText(voucher, "PARTYNAME") ||
    childText(voucher, "BASICBUYERNAME") ||
    "Unnamed supplier";

  const gstinRaw =
    childText(voucher, "PARTYGSTIN") ||
    childText(voucher, "CONSIGNEEGSTIN") ||
    childText(voucher, "GSTREGISTRATIONNUMBER");

  const supplierGstin = normalizeGstin(gstinRaw);
  if (!supplierGstin) {
    warnings.push(
      "No GSTIN on this voucher. It cannot be reconciled against GSTR-2B until the party ledger " +
        "carries a GSTIN — the invoice is imported so the amount is not lost, but it will show as unmatched.",
    );
  }

  // ---- Walk the ledger entries ------------------------------------------
  const entries = findAll(voucher, "ALLLEDGERENTRIES.LIST").concat(
    findAll(voucher, "LEDGERENTRIES.LIST"),
  );

  if (entries.length === 0) {
    return { error: "Voucher has no ledger entries; nothing to import." };
  }

  const tax: TaxAmounts = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
  let partyAmount = 0;
  let expenseAmount = 0;
  let unreadable = 0;

  for (const entry of entries) {
    const ledgerName = collapse(childText(entry, "LEDGERNAME")).toUpperCase();
    const amountText = childText(entry, "AMOUNT");
    const amount = parsePaise(amountText);

    if (amount === null) {
      unreadable += 1;
      continue;
    }

    const isParty =
      /^(YES|TRUE)$/i.test(childText(entry, "ISPARTYLEDGER")) ||
      collapse(childText(entry, "LEDGERNAME")).toUpperCase() === collapse(partyName).toUpperCase();

    if (isParty) {
      partyAmount += amount;
      continue;
    }

    const head = TAX_PATTERNS.find((p) => p.test.test(ledgerName))?.head;
    if (head) {
      tax[head] += amount;
    } else {
      expenseAmount += amount;
    }
  }

  if (unreadable > 0) {
    warnings.push(
      `${unreadable} ledger line${unreadable === 1 ? "" : "s"} had an amount that could not be read and ` +
        "were excluded from the totals. Verify this voucher manually.",
    );
  }

  // Tally credits the party (negative) and debits expense and tax (positive)
  // on a purchase. Work in absolute terms and let documentType carry the sign,
  // so a register exported with either convention lands the same way.
  const taxableValue = Math.abs(expenseAmount);
  const totalTax = Math.abs(tax.igst) + Math.abs(tax.cgst) + Math.abs(tax.sgst) + Math.abs(tax.cess);
  const invoiceValue = Math.abs(partyAmount) || taxableValue + totalTax;

  const absTax: TaxAmounts = {
    igst: Math.abs(tax.igst),
    cgst: Math.abs(tax.cgst),
    sgst: Math.abs(tax.sgst),
    cess: Math.abs(tax.cess),
  };

  if (taxableValue === 0 && totalTax === 0) {
    return { error: "Voucher has ledger entries but every amount is zero; nothing to import." };
  }

  // The two sides of a voucher must agree. When they do not, something was
  // classified wrongly and the credit figure cannot be trusted — say so
  // rather than importing a number that looks authoritative and is not.
  const imbalance = Math.abs(invoiceValue - (taxableValue + totalTax));
  if (imbalance > 100) {
    warnings.push(
      `Ledger entries do not balance: party total is ${(invoiceValue / 100).toFixed(2)} but ` +
        `taxable plus tax is ${((taxableValue + totalTax) / 100).toFixed(2)}. ` +
        "A ledger may be misclassified — check before relying on the credit shown.",
    );
  }

  const sign = documentType === "CREDIT_NOTE" ? -1 : 1;

  const record: PurchaseRecord = {
    id: nextId(),
    supplierGstin,
    supplierName: collapse(partyName),
    invoiceNumber: collapse(supplierInvoiceNumber),
    invoiceDate,
    documentType,
    taxableValue: sign * taxableValue,
    tax: sign === -1 ? negate(absTax) : absTax,
    invoiceValue: sign * invoiceValue,
    placeOfSupply: childText(voucher, "PLACEOFSUPPLY") || undefined,
    reverseCharge: /^(YES|TRUE)$/i.test(childText(voucher, "ISREVERSECHARGEAPPLICABLE")),
    sourceRow: undefined,
  };

  return { record, warnings };
}

function negate(t: TaxAmounts): TaxAmounts {
  return { igst: -t.igst, cgst: -t.cgst, sgst: -t.sgst, cess: -t.cess };
}

// ---------------------------------------------------------------------------
// Company list
// ---------------------------------------------------------------------------

export interface TallyCompany {
  name: string;
  startingFrom?: string;
}

export function parseCompanies(rawXml: string): TallyCompany[] {
  const doc = parseXmlDocument(rawXml);
  const out: TallyCompany[] = [];
  const seen = new Set<string>();

  for (const node of findAll(doc.root, "COMPANY")) {
    const name = collapse(childText(node, "NAME") || node.attrs.NAME || "");
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      startingFrom: fromTallyDate(childText(node, "STARTINGFROM")) ?? undefined,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Ledger masters — the GSTIN source of truth
// ---------------------------------------------------------------------------

export interface TallyLedger {
  name: string;
  gstin?: string;
  /** Tally's own party classification, used to skip non-supplier ledgers. */
  parent?: string;
}

/**
 * Harvest supplier GSTINs from the ledger masters.
 *
 * Worth pulling separately because many companies record the GSTIN once on the
 * ledger and never on the voucher. Merging the two gives a far higher match
 * rate than vouchers alone.
 */
export function parseLedgers(rawXml: string): TallyLedger[] {
  const doc = parseXmlDocument(rawXml);
  const out: TallyLedger[] = [];

  for (const node of findAll(doc.root, "LEDGER")) {
    const name = collapse(childText(node, "NAME") || node.attrs.NAME || "");
    if (!name) continue;

    const gstin = normalizeGstin(
      childText(node, "PARTYGSTIN") || childText(node, "GSTREGISTRATIONNUMBER"),
    );

    out.push({
      name,
      gstin: gstin || undefined,
      parent: collapse(childText(node, "PARENT")) || undefined,
    });
  }

  return out;
}

/** Fill in missing voucher GSTINs from the ledger masters, by exact ledger name. */
export function applyLedgerGstins(
  records: PurchaseRecord[],
  ledgers: TallyLedger[],
): { records: PurchaseRecord[]; filled: number } {
  const byName = new Map<string, string>();
  for (const l of ledgers) {
    if (l.gstin) byName.set(l.name.toUpperCase(), l.gstin);
  }

  let filled = 0;
  const out = records.map((r) => {
    if (r.supplierGstin) return r;
    const gstin = byName.get(r.supplierName.toUpperCase());
    if (!gstin) return r;
    filled += 1;
    return { ...r, supplierGstin: gstin };
  });

  return { records: out, filled };
}
