/**
 * Tally XML request envelopes.
 *
 * Tally's HTTP gateway speaks one thing: an `<ENVELOPE>` POSTed to `/`. The
 * header selects *what* to export, the body's `<STATICVARIABLES>` block
 * supplies the report's parameters, and an optional `<TDL>` block defines an
 * ad-hoc collection when no stock report gives us what we need.
 *
 * Two rules that bite everyone who writes this code the first time:
 *
 *  - `<SVCURRENTCOMPANY>` must be the company's name *exactly* as it is open in
 *    Tally, character for character. A trailing space or a straight-vs-curly
 *    apostrophe and Tally silently returns an empty body rather than an error.
 *  - Every interpolated value must be XML-escaped. Indian company and ledger
 *    names contain `&` constantly ("Shah & Co", "Bharat Tools & Dies"), and an
 *    unescaped one makes Tally reject the whole envelope.
 */

import { TallyError } from "./errors";

/** Tally's date format on the wire. */
export type TallyDate = string; // YYYYMMDD

export const DEFAULT_TALLY_URL = "http://localhost:9000";

/**
 * The report Tally exposes for "every voucher in a period". `Day Book` is the
 * other candidate and returns the same voucher shape, but it ignores
 * `VOUCHERTYPENAME` filtering on some builds, so we default to this one.
 */
export const PURCHASE_REGISTER_REPORT_ID = "Voucher Register";

/**
 * Is this code point legal in an XML 1.0 document?
 *
 * Tab (9), line feed (10) and carriage return (13) are legal; every other C0
 * control is not, and cannot be rescued by a numeric character reference
 * either. Tally rejects the whole envelope when one appears, and company names
 * pasted out of Excel carry them more often than you would believe.
 *
 * Written as an explicit code-point comparison rather than a regex character
 * class on purpose. A previous revision expressed this as a class built from
 * literal control characters, which collapsed into the range "space through
 * hyphen" and silently deleted every space, ampersand, quote and comma it saw.
 * "Kaveri Logistics & Freight" became "KaveriLogisticsFreight", and Tally was
 * then asked for a company that does not exist — returning an empty body with
 * no error, which is the hardest possible failure to diagnose. Comparing
 * numbers cannot fail that way.
 */
function isLegalXmlChar(code: number): boolean {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
  if (code < 0x20) return false;
  // DEL and the C1 block are technically legal in XML 1.0 but are never
  // meaningful in a ledger name and upset Tally's parser, so they go too.
  if (code >= 0x7f && code <= 0x9f) return false;
  return true;
}

export function escapeXml(value: string): string {
  let out = "";

  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined || !isLegalXmlChar(code)) continue;

    switch (char) {
      case "&":
        out += "&amp;";
        break;
      case "<":
        out += "&lt;";
        break;
      case ">":
        out += "&gt;";
        break;
      case '"':
        out += "&quot;";
        break;
      case "'":
        out += "&apos;";
        break;
      default:
        out += char;
    }
  }

  return out;
}

/**
 * Normalise a date to Tally's `YYYYMMDD`.
 *
 * Accepts our domain `ISODate` (`YYYY-MM-DD`) or an already-Tally date, and
 * rejects anything else loudly. A silently wrong `SVFROMDATE` returns the wrong
 * month's vouchers, which reconciles cleanly against the wrong 2B and produces
 * a confident, wrong answer — the worst possible failure for this product.
 */
export function toTallyDate(input: string): TallyDate {
  const value = input.trim();

  let year: number;
  let month: number;
  let day: number;

  if (/^\d{8}$/.test(value)) {
    year = Number(value.slice(0, 4));
    month = Number(value.slice(4, 6));
    day = Number(value.slice(6, 8));
  } else {
    const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!iso) {
      throw new TallyError("BAD_REQUEST", `Date must be YYYY-MM-DD or YYYYMMDD, received "${input}".`);
    }
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  }

  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day ||
    year < 2000 ||
    year > 2100
  ) {
    throw new TallyError("BAD_REQUEST", `"${input}" is not a real calendar date.`);
  }

  return `${year}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`;
}

/** `20260405` → `2026-04-05`. Returns null when Tally sends something else. */
export function fromTallyDate(value: string): string | null {
  const match = value.trim().match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return null;
  const [, y, m, d] = match;
  const probe = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (probe.getUTCMonth() !== Number(m) - 1 || probe.getUTCDate() !== Number(d)) return null;
  return `${y}-${m}-${d}`;
}

function requireCompany(company: string): string {
  const trimmed = company.trim();
  if (!trimmed) {
    throw new TallyError("BAD_REQUEST", "A company name is required — pick one from the companies list first.");
  }
  return trimmed;
}

interface EnvelopeSpec {
  /** `Export` for reads. We never send `Import`: this connector is read-only. */
  tallyRequest: "Export";
  /** `Data` for a report, `Collection` for a TDL collection. */
  type: "Data" | "Collection";
  id: string;
  staticVariables: string;
  /** Optional inline TDL, for collections that have no stock report. */
  tdl?: string;
}

function envelope(spec: EnvelopeSpec): string {
  const tdl = spec.tdl ? `<TDL><TDLMESSAGE>${spec.tdl}</TDLMESSAGE></TDL>` : "";
  return [
    "<ENVELOPE>",
    "<HEADER>",
    "<VERSION>1</VERSION>",
    `<TALLYREQUEST>${spec.tallyRequest}</TALLYREQUEST>`,
    `<TYPE>${spec.type}</TYPE>`,
    `<ID>${escapeXml(spec.id)}</ID>`,
    "</HEADER>",
    "<BODY><DESC>",
    `<STATICVARIABLES>${spec.staticVariables}</STATICVARIABLES>`,
    tdl,
    "</DESC></BODY>",
    "</ENVELOPE>",
  ].join("");
}

/** Every request must ask for XML; the default export format is ASCII text. */
const XML_FORMAT = "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>";

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * List the companies Tally can serve.
 *
 * Important operational limit: this returns the companies currently **open** in
 * Tally, not every company on disk. Tally will not load a company on our behalf
 * over the gateway, so if the user's company is missing from this list the fix
 * is to open it in Tally, not to retry.
 *
 * There is no stock report for this, so we define a one-off TDL collection over
 * the `Company` object and ask for the native methods we need.
 */
export function listCompaniesRequest(): string {
  return envelope({
    tallyRequest: "Export",
    type: "Collection",
    id: "List of Companies",
    staticVariables: XML_FORMAT,
    tdl: [
      '<COLLECTION NAME="List of Companies" ISINITIALIZE="Yes">',
      "<TYPE>Company</TYPE>",
      "<NATIVEMETHOD>Name</NATIVEMETHOD>",
      "<NATIVEMETHOD>StartingFrom</NATIVEMETHOD>",
      "<NATIVEMETHOD>EndingAt</NATIVEMETHOD>",
      "<NATIVEMETHOD>CompanyNumber</NATIVEMETHOD>",
      "<NATIVEMETHOD>GSTRegistrationNumber</NATIVEMETHOD>",
      "<NATIVEMETHOD>StateName</NATIVEMETHOD>",
      "</COLLECTION>",
    ].join(""),
  });
}

export interface PurchaseRegisterRequestOptions {
  company: string;
  /** `YYYY-MM-DD` or `YYYYMMDD`. */
  fromDate: string;
  /** `YYYY-MM-DD` or `YYYYMMDD`. Inclusive. */
  toDate: string;
  /**
   * Voucher type to filter on. Tally matches user-defined types by their
   * parent, so "Purchase" also brings in "Purchase - GST", "Purchase Import"
   * and every other type a consultant created under Purchase.
   *
   * Pass null to pull *all* voucher types and let the parser filter. That is
   * slower and much larger, but it is the escape hatch when a site's purchase
   * types were created under a non-standard parent.
   */
  voucherTypeName?: string | null;
  /** Override the report. See PURCHASE_REGISTER_REPORT_ID. */
  reportId?: string;
}

/**
 * Purchase vouchers for a period, with their ledger entries.
 *
 * `EXPLODEFLAG` is what makes Tally emit the `ALLLEDGERENTRIES.LIST` children
 * rather than one summary line per voucher. Without it the response looks
 * plausible and contains no tax breakup at all — which would quietly produce a
 * register with zero ITC on every line.
 */
export function purchaseRegisterRequest(options: PurchaseRegisterRequestOptions): string {
  const company = requireCompany(options.company);
  const from = toTallyDate(options.fromDate);
  const to = toTallyDate(options.toDate);

  if (from > to) {
    throw new TallyError("BAD_REQUEST", `From date (${from}) is after the to date (${to}).`);
  }

  const voucherType =
    options.voucherTypeName === null
      ? ""
      : `<VOUCHERTYPENAME>${escapeXml(options.voucherTypeName ?? "Purchase")}</VOUCHERTYPENAME>`;

  return envelope({
    tallyRequest: "Export",
    type: "Data",
    id: options.reportId ?? PURCHASE_REGISTER_REPORT_ID,
    staticVariables: [
      XML_FORMAT,
      `<SVFROMDATE TYPE="Date">${from}</SVFROMDATE>`,
      `<SVTODATE TYPE="Date">${to}</SVTODATE>`,
      `<SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY>`,
      voucherType,
      "<EXPLODEFLAG>Yes</EXPLODEFLAG>",
    ].join(""),
  });
}

export interface LedgerMastersRequestOptions {
  company: string;
  /**
   * Restrict to a group. "Sundry Creditors" is where suppliers live in every
   * standard chart of accounts, and pulling only that group turns a
   * multi-megabyte full ledger dump into a few hundred rows.
   */
  group?: string | null;
}

/**
 * Supplier ledger masters — the authoritative source for a vendor's GSTIN.
 *
 * We need this because `PARTYGSTIN` on the voucher is only stamped when the
 * ledger had a GSTIN at the moment the voucher was saved. Back-dated vouchers
 * entered before the GSTIN was filled in carry a blank, and the master is the
 * only place to recover it.
 */
export function ledgerMastersRequest(options: LedgerMastersRequestOptions): string {
  const company = requireCompany(options.company);
  const group = options.group === undefined ? "Sundry Creditors" : options.group;

  const filter = group
    ? [
        `<FILTER>ITCGuardGroupFilter</FILTER>`,
        `</COLLECTION>`,
        `<SYSTEM TYPE="Formulae" NAME="ITCGuardGroupFilter">$$IsLedOfGrp:$Parent:"${escapeXml(group)}"</SYSTEM>`,
      ].join("")
    : "</COLLECTION>";

  return envelope({
    tallyRequest: "Export",
    type: "Collection",
    id: "Ledger Masters",
    staticVariables: [XML_FORMAT, `<SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY>`].join(""),
    tdl: [
      '<COLLECTION NAME="Ledger Masters" ISMODIFY="No">',
      "<TYPE>Ledger</TYPE>",
      "<NATIVEMETHOD>Name</NATIVEMETHOD>",
      "<NATIVEMETHOD>Parent</NATIVEMETHOD>",
      "<NATIVEMETHOD>PartyGSTIN</NATIVEMETHOD>",
      "<NATIVEMETHOD>GSTRegistrationType</NATIVEMETHOD>",
      "<NATIVEMETHOD>LedStateName</NATIVEMETHOD>",
      "<NATIVEMETHOD>CountryName</NATIVEMETHOD>",
      "<NATIVEMETHOD>LedgerContact</NATIVEMETHOD>",
      "<NATIVEMETHOD>Email</NATIVEMETHOD>",
      filter,
    ].join(""),
  });
}
