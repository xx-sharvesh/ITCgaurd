import { describe, expect, it } from "vitest";
import { parseCompanies, parseLedgers, applyLedgerGstins, parsePurchaseVouchers } from "./parse";
import { assertAllowedTallyUrl } from "./url-guard";
import { escapeXml, fromTallyDate, toTallyDate } from "./requests";
import { totalTax } from "../domain/money";

/**
 * Fixtures reproduce the quirks a real TallyPrime gateway emits, several of
 * which break a naive parser outright:
 *   - a bare `&` in a party name (invalid XML, and extremely common)
 *   - negative amounts with Indian digit grouping
 *   - tax spread across separately-named ledgers with no machine-readable flag
 *   - a voucher with no PARTYGSTIN
 *   - a credit note mixed into the purchase register
 *   - non-purchase vouchers that must be ignored
 */
const PURCHASE_REGISTER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
 <BODY><IMPORTDATA><REQUESTDATA>

  <TALLYMESSAGE>
   <VOUCHER VCHTYPE="Purchase" ACTION="Create">
    <DATE>20260705</DATE>
    <VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>
    <VOUCHERNUMBER>PUR/0412</VOUCHERNUMBER>
    <REFERENCE>SBT/2026-27/0091</REFERENCE>
    <PARTYLEDGERNAME>Shree Balaji Steel Traders</PARTYLEDGERNAME>
    <PARTYGSTIN>27AABCS1429B1ZP</PARTYGSTIN>
    <PLACEOFSUPPLY>27</PLACEOFSUPPLY>
    <ALLLEDGERENTRIES.LIST>
     <LEDGERNAME>Shree Balaji Steel Traders</LEDGERNAME>
     <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
     <AMOUNT>-1,18,000.00</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST>
     <LEDGERNAME>Purchase - Raw Material</LEDGERNAME>
     <AMOUNT>1,00,000.00</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST>
     <LEDGERNAME>CGST Input @ 9%</LEDGERNAME>
     <AMOUNT>9000.00</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST>
     <LEDGERNAME>SGST Input @ 9%</LEDGERNAME>
     <AMOUNT>9000.00</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
   </VOUCHER>
  </TALLYMESSAGE>

  <TALLYMESSAGE>
   <VOUCHER VCHTYPE="Purchase" ACTION="Create">
    <DATE>20260712</DATE>
    <VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>
    <VOUCHERNUMBER>PUR/0413</VOUCHERNUMBER>
    <REFERENCE>KLP-2627-0034</REFERENCE>
    <PARTYLEDGERNAME>Kaveri Logistics & Freight LLP</PARTYLEDGERNAME>
    <PARTYGSTIN>29AAACI1195H1ZH</PARTYGSTIN>
    <ALLLEDGERENTRIES.LIST>
     <LEDGERNAME>Kaveri Logistics &amp; Freight LLP</LEDGERNAME>
     <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
     <AMOUNT>-59000.00</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST>
     <LEDGERNAME>Freight Inward</LEDGERNAME>
     <AMOUNT>50000.00</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST>
     <LEDGERNAME>IGST Input @ 18%</LEDGERNAME>
     <AMOUNT>9000.00</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
   </VOUCHER>
  </TALLYMESSAGE>

  <TALLYMESSAGE>
   <VOUCHER VCHTYPE="Credit Note" ACTION="Create">
    <DATE>20260718</DATE>
    <VOUCHERTYPENAME>Credit Note</VOUCHERTYPENAME>
    <VOUCHERNUMBER>CN/0021</VOUCHERNUMBER>
    <REFERENCE>SBT/CN/0007</REFERENCE>
    <PARTYLEDGERNAME>Shree Balaji Steel Traders</PARTYLEDGERNAME>
    <PARTYGSTIN>27AABCS1429B1ZP</PARTYGSTIN>
    <ALLLEDGERENTRIES.LIST>
     <LEDGERNAME>Shree Balaji Steel Traders</LEDGERNAME>
     <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
     <AMOUNT>11800.00</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST>
     <LEDGERNAME>Purchase - Raw Material</LEDGERNAME>
     <AMOUNT>-10000.00</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST>
     <LEDGERNAME>CGST Input @ 9%</LEDGERNAME>
     <AMOUNT>-900.00</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST>
     <LEDGERNAME>SGST Input @ 9%</LEDGERNAME>
     <AMOUNT>-900.00</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
   </VOUCHER>
  </TALLYMESSAGE>

  <TALLYMESSAGE>
   <VOUCHER VCHTYPE="Purchase" ACTION="Create">
    <DATE>20260720</DATE>
    <VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>
    <VOUCHERNUMBER>PUR/0414</VOUCHERNUMBER>
    <REFERENCE>NPI/0553</REFERENCE>
    <PARTYLEDGERNAME>Nirmal Packaging Industries</PARTYLEDGERNAME>
    <ALLLEDGERENTRIES.LIST>
     <LEDGERNAME>Nirmal Packaging Industries</LEDGERNAME>
     <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
     <AMOUNT>-23600.00</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST>
     <LEDGERNAME>Packing Material</LEDGERNAME>
     <AMOUNT>20000.00</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST>
     <LEDGERNAME>CGST Input @ 9%</LEDGERNAME>
     <AMOUNT>1800.00</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST>
     <LEDGERNAME>SGST Input @ 9%</LEDGERNAME>
     <AMOUNT>1800.00</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
   </VOUCHER>
  </TALLYMESSAGE>

  <TALLYMESSAGE>
   <VOUCHER VCHTYPE="Payment" ACTION="Create">
    <DATE>20260722</DATE>
    <VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>
    <VOUCHERNUMBER>PAY/0900</VOUCHERNUMBER>
    <ALLLEDGERENTRIES.LIST>
     <LEDGERNAME>HDFC Bank</LEDGERNAME>
     <AMOUNT>-118000.00</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
   </VOUCHER>
  </TALLYMESSAGE>

 </REQUESTDATA></IMPORTDATA></BODY>
</ENVELOPE>`;

const COMPANIES_XML = `<ENVELOPE>
 <BODY><DATA><COLLECTION>
  <COMPANY NAME="Vasudha Engineering Industries Pvt Ltd">
   <NAME>Vasudha Engineering Industries Pvt Ltd</NAME>
   <STARTINGFROM>20260401</STARTINGFROM>
  </COMPANY>
  <COMPANY NAME="Vasudha Exports &amp; Trading">
   <NAME>Vasudha Exports &amp; Trading</NAME>
   <STARTINGFROM>20250401</STARTINGFROM>
  </COMPANY>
 </COLLECTION></DATA></BODY>
</ENVELOPE>`;

const LEDGERS_XML = `<ENVELOPE>
 <BODY><DATA><COLLECTION>
  <LEDGER NAME="Nirmal Packaging Industries">
   <NAME>Nirmal Packaging Industries</NAME>
   <PARENT>Sundry Creditors</PARENT>
   <PARTYGSTIN>27AAFCN9040G1ZR</PARTYGSTIN>
  </LEDGER>
  <LEDGER NAME="HDFC Bank">
   <NAME>HDFC Bank</NAME>
   <PARENT>Bank Accounts</PARENT>
  </LEDGER>
 </COLLECTION></DATA></BODY>
</ENVELOPE>`;

describe("Tally date conversion", () => {
  it("round-trips ISO to Tally's YYYYMMDD", () => {
    expect(toTallyDate("2026-07-05")).toBe("20260705");
    expect(fromTallyDate("20260705")).toBe("2026-07-05");
    expect(fromTallyDate("garbage")).toBeNull();
  });
});

describe("XML escaping", () => {
  it("escapes ampersands in company names, which are everywhere in Indian firm names", () => {
    expect(escapeXml("Kaveri Logistics & Freight")).toContain("&amp;");
    expect(escapeXml("Kaveri Logistics & Freight")).not.toMatch(/&(?!amp;)/);
  });
});

describe("purchase voucher parsing", () => {
  const result = parsePurchaseVouchers(PURCHASE_REGISTER_XML);

  it("imports only inward-supply vouchers", () => {
    // Five vouchers in the file; the Payment must be ignored.
    expect(result.vouchersSeen).toBe(5);
    expect(result.records).toHaveLength(4);
    expect(result.records.map((r) => r.invoiceNumber)).toEqual([
      "SBT/2026-27/0091",
      "KLP-2627-0034",
      "SBT/CN/0007",
      "NPI/0553",
    ]);
  });

  it("survives a bare ampersand in a party name", () => {
    const kaveri = result.records[1];
    expect(kaveri.supplierName).toContain("&");
    expect(kaveri.supplierGstin).toBe("29AAACI1195H1ZH");
  });

  it("reconstructs taxable value by removing tax ledgers from the debit side", () => {
    const steel = result.records[0];
    expect(steel.taxableValue).toBe(100_000_00);
    expect(steel.tax.cgst).toBe(9_000_00);
    expect(steel.tax.sgst).toBe(9_000_00);
    expect(steel.tax.igst).toBe(0);
    expect(steel.invoiceValue).toBe(118_000_00);
  });

  it("splits inter-state IGST from intra-state CGST+SGST by ledger name", () => {
    const freight = result.records[1];
    expect(freight.tax.igst).toBe(9_000_00);
    expect(freight.tax.cgst).toBe(0);
    expect(freight.tax.sgst).toBe(0);
  });

  it("types a credit note and gives it negative credit", () => {
    const note = result.records[2];
    expect(note.documentType).toBe("CREDIT_NOTE");
    expect(note.taxableValue).toBeLessThan(0);
    expect(totalTax(note.tax)).toBeLessThan(0);
  });

  it("warns rather than dropping a voucher with no GSTIN", () => {
    const noGstin = result.records[3];
    expect(noGstin.supplierGstin).toBe("");
    expect(result.warnings.some((w) => w.voucher === "PUR/0414" && /GSTIN/i.test(w.message))).toBe(true);
  });

  it("keeps every amount an integer number of paise", () => {
    for (const r of result.records) {
      expect(Number.isInteger(r.taxableValue)).toBe(true);
      expect(Number.isInteger(r.invoiceValue)).toBe(true);
      for (const head of Object.values(r.tax)) expect(Number.isInteger(head)).toBe(true);
    }
  });

  it("flags a truncated response instead of reporting a short register", () => {
    const cut = PURCHASE_REGISTER_XML.slice(0, PURCHASE_REGISTER_XML.length - 400);
    const partial = parsePurchaseVouchers(cut);
    expect(partial.truncated).toBe(true);
    expect(partial.warnings.some((w) => /INCOMPLETE/.test(w.message))).toBe(true);
  });
});

describe("companies and ledgers", () => {
  it("reads the company list", () => {
    const companies = parseCompanies(COMPANIES_XML);
    expect(companies.map((c) => c.name)).toEqual([
      "Vasudha Engineering Industries Pvt Ltd",
      "Vasudha Exports & Trading",
    ]);
    expect(companies[0].startingFrom).toBe("2026-04-01");
  });

  it("recovers a missing voucher GSTIN from the ledger master", () => {
    const { records } = parsePurchaseVouchers(PURCHASE_REGISTER_XML);
    const applied = applyLedgerGstins(records, parseLedgers(LEDGERS_XML));
    expect(applied.filled).toBe(1);
    expect(applied.records[3].supplierGstin).toBe("27AAFCN9040G1ZR");
  });
});

describe("SSRF guard", () => {
  it("allows loopback and private space", () => {
    for (const url of [
      "http://localhost:9000",
      "http://127.0.0.1:9000",
      "http://192.168.1.44:9000",
      "http://10.0.0.5:9000",
      "http://172.20.3.9:9000",
    ]) {
      expect(() => assertAllowedTallyUrl(url), url).not.toThrow();
    }
  });

  it("rejects public addresses, non-http schemes, and hostnames that could rebind", () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/", // cloud metadata
      "http://8.8.8.8:9000",
      "https://example.com",
      "http://evil.example.com:9000", // a name can resolve anywhere
      "http://172.32.0.1:9000", // just outside the private 172.16-31 range
      "file:///etc/passwd",
      "not a url",
    ]) {
      expect(() => assertAllowedTallyUrl(url), url).toThrow();
    }
  });
});
