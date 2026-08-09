/**
 * Column detection for purchase registers.
 *
 * There is no standard purchase-register format. Every client's file is
 * whatever their accountant built in 2016, and asking a CFO to remap columns
 * before they can see their number is exactly the "more work" this product
 * exists to remove. So we detect the columns ourselves, show the user what we
 * inferred, and let them correct it — rather than making mapping the price of
 * entry.
 *
 * Synonyms below come from Tally, Busy, Zoho Books, Marg, SAP B1 and the GST
 * portal's own exports.
 */

export type FieldKey =
  | "supplierGstin"
  | "supplierName"
  | "invoiceNumber"
  | "invoiceDate"
  | "taxableValue"
  | "igst"
  | "cgst"
  | "sgst"
  | "cess"
  | "invoiceValue"
  | "placeOfSupply"
  | "documentType"
  | "reverseCharge"
  | "paymentDate"
  | "msmeStatus"
  | "rate";

interface FieldSpec {
  key: FieldKey;
  /** Lowercased, punctuation-stripped candidates. Order does not matter. */
  synonyms: string[];
  /** Substrings that disqualify a header even if a synonym matched. */
  negative?: string[];
  required: boolean;
}

/**
 * Ordered by specificity. "invoice value" must be tested before "value", and
 * the tax heads before "tax", or a greedy match steals the wrong column.
 */
export const FIELD_SPECS: FieldSpec[] = [
  {
    key: "supplierGstin",
    synonyms: [
      "supplier gstin", "gstin of supplier", "gstin supplier", "party gstin", "vendor gstin",
      "gstin uin of supplier", "gstin", "gst no", "gst number", "gstin no", "ctin",
    ],
    negative: ["recipient", "buyer", "our", "company"],
    required: true,
  },
  {
    key: "supplierName",
    synonyms: [
      "supplier name", "vendor name", "party name", "trade name", "supplier trade name",
      "name of supplier", "particulars", "party", "supplier", "vendor", "ledger name", "trdnm",
    ],
    negative: ["gstin", "code", "state"],
    required: false,
  },
  {
    key: "invoiceNumber",
    synonyms: [
      "invoice number", "invoice no", "inv no", "inv number", "bill no", "bill number",
      "document number", "document no", "doc no", "voucher no", "voucher number",
      "supplier invoice no", "reference no", "inum", "note no", "note number",
    ],
    negative: ["date", "value", "amount"],
    required: true,
  },
  {
    key: "invoiceDate",
    synonyms: [
      "invoice date", "inv date", "bill date", "document date", "doc date", "voucher date",
      "date of invoice", "supplier invoice date", "idt", "note date", "date",
    ],
    negative: ["payment", "due", "receipt", "entry"],
    required: true,
  },
  {
    key: "taxableValue",
    synonyms: [
      "taxable value", "taxable amount", "assessable value", "assessable amount",
      "basic value", "basic amount", "net amount", "value of supply", "txval", "taxable",
    ],
    required: true,
  },
  { key: "igst", synonyms: ["igst amount", "igst amt", "integrated tax", "integrated tax amount", "igst"], required: false },
  { key: "cgst", synonyms: ["cgst amount", "cgst amt", "central tax", "central tax amount", "cgst"], required: false },
  { key: "sgst", synonyms: ["sgst amount", "sgst amt", "state tax", "state tax amount", "sgst utgst", "utgst", "sgst"], required: false },
  { key: "cess", synonyms: ["cess amount", "cess amt", "compensation cess", "cess"], required: false },
  {
    key: "invoiceValue",
    synonyms: [
      "invoice value", "total invoice value", "bill value", "gross amount", "gross total",
      "total amount", "grand total", "amount", "val", "total",
    ],
    negative: ["taxable", "tax amount"],
    required: false,
  },
  {
    key: "placeOfSupply",
    synonyms: ["place of supply", "pos", "supply state", "state code", "place of supply state"],
    required: false,
  },
  {
    key: "documentType",
    synonyms: ["document type", "doc type", "type", "voucher type", "note type", "nature of document"],
    required: false,
  },
  {
    key: "reverseCharge",
    synonyms: ["reverse charge", "rcm", "supply attract reverse charge", "rev charge", "rev"],
    required: false,
  },
  {
    key: "paymentDate",
    synonyms: [
      "payment date", "paid on", "date of payment", "settlement date", "payment dt", "paid date",
    ],
    required: false,
  },
  {
    key: "msmeStatus",
    synonyms: ["msme", "msme status", "udyam", "udyam status", "enterprise type", "msme category"],
    required: false,
  },
  { key: "rate", synonyms: ["rate", "tax rate", "gst rate", "rt", "rate percent"], required: false },
];

/** Lowercase, collapse punctuation and whitespace, drop trailing units. */
export function normalizeHeader(raw: string): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\brs\b|\binr\b|\bamt\b$/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ColumnMapping {
  /** Field → zero-based column index in the source sheet. */
  map: Partial<Record<FieldKey, number>>;
  /** Header text we matched, for showing the user what we inferred. */
  matchedHeaders: Partial<Record<FieldKey, string>>;
  /** Required fields we could not find. */
  missing: FieldKey[];
  /** Headers we did not recognise — surfaced, never silently dropped. */
  unmapped: string[];
  /** 0..1 confidence in the overall mapping. */
  confidence: number;
}

/**
 * Infer a mapping from a header row.
 *
 * Scoring: exact normalised equality beats containment, and longer synonyms
 * beat shorter ones so "invoice value" wins over "value" for the same header.
 * Each column is claimed at most once.
 */
export function detectColumns(headerRow: unknown[]): ColumnMapping {
  const headers = headerRow.map((h) => normalizeHeader(String(h ?? "")));

  interface Claim { field: FieldKey; column: number; score: number; header: string }
  const claims: Claim[] = [];

  for (const spec of FIELD_SPECS) {
    for (let col = 0; col < headers.length; col++) {
      const h = headers[col];
      if (!h) continue;
      if (spec.negative?.some((n) => h.includes(n))) continue;

      let best = 0;
      for (const syn of spec.synonyms) {
        if (h === syn) {
          best = Math.max(best, 100 + syn.length);
        } else if (h.includes(syn)) {
          // Containment is weaker, and weaker still when the header carries a
          // lot of extra words we did not account for.
          best = Math.max(best, 50 + syn.length - (h.length - syn.length) * 0.5);
        }
      }

      if (best > 0) claims.push({ field: spec.key, column: col, score: best, header: String(headerRow[col] ?? "") });
    }
  }

  claims.sort((a, b) => b.score - a.score);

  const map: Partial<Record<FieldKey, number>> = {};
  const matchedHeaders: Partial<Record<FieldKey, string>> = {};
  const takenColumns = new Set<number>();

  for (const c of claims) {
    if (map[c.field] !== undefined) continue;
    if (takenColumns.has(c.column)) continue;
    map[c.field] = c.column;
    matchedHeaders[c.field] = c.header;
    takenColumns.add(c.column);
  }

  const missing = FIELD_SPECS.filter((s) => s.required && map[s.key] === undefined).map((s) => s.key);

  const unmapped = headerRow
    .map((h, i) => ({ h: String(h ?? "").trim(), i }))
    .filter(({ h, i }) => h && !takenColumns.has(i))
    .map(({ h }) => h);

  const requiredCount = FIELD_SPECS.filter((s) => s.required).length;
  const foundRequired = requiredCount - missing.length;
  const taxHeadsFound = (["igst", "cgst", "sgst"] as FieldKey[]).filter((k) => map[k] !== undefined).length;

  const confidence = Math.min(
    1,
    (foundRequired / requiredCount) * 0.75 + (taxHeadsFound / 3) * 0.25,
  );

  return { map, matchedHeaders, missing, unmapped, confidence };
}
