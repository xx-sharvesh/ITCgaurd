import { describe, expect, it } from "vitest";
import {
  absDelta,
  formatINR,
  formatINRCompact,
  parsePaise,
  rupeesToPaise,
  sumTax,
  totalTax,
} from "./money";
import {
  computeGstinCheckDigit,
  isValidGstin,
  panFromGstin,
  validateGstin,
} from "./gstin";
import {
  addDays,
  boundedLevenshtein,
  daysBetween,
  financialYearOf,
  invoiceKeys,
  parseGstDate,
  sec16_4Deadline,
  vendorNameKey,
} from "./normalize";

describe("money — integer paise discipline", () => {
  it("parses the amount formats that appear in Indian registers", () => {
    expect(parsePaise("1,23,456.78")).toBe(12_345_678);
    expect(parsePaise("₹1234.50")).toBe(123_450);
    expect(parsePaise("Rs. 1,000")).toBe(100_000);
    expect(parsePaise("INR 250.25")).toBe(25_025);
    expect(parsePaise("(1,234.00)")).toBe(-123_400);
    expect(parsePaise("-500")).toBe(-50_000);
    expect(parsePaise(1234.56)).toBe(123_456);
  });

  it("returns null rather than zero for unreadable input", () => {
    // A silent zero here would understate the register and hide missing credit.
    expect(parsePaise("")).toBeNull();
    expect(parsePaise("  ")).toBeNull();
    expect(parsePaise("N/A")).toBeNull();
    expect(parsePaise("-")).toBeNull();
    expect(parsePaise(null)).toBeNull();
    expect(parsePaise(undefined)).toBeNull();
    expect(parsePaise(Number.NaN)).toBeNull();
  });

  it("does not lose a paise to floating point", () => {
    // 0.1 + 0.2 in IEEE-754 is the canonical trap.
    expect(rupeesToPaise(0.1) + rupeesToPaise(0.2)).toBe(rupeesToPaise(0.3));
    expect(rupeesToPaise(1234.565)).toBe(123_457);
    expect(rupeesToPaise(-1234.565)).toBe(-123_457);
  });

  it("sums tax heads without drift over many lines", () => {
    const line = { igst: 0, cgst: 900_05, sgst: 900_05, cess: 0 };
    const total = sumTax(Array.from({ length: 10_000 }, () => line));
    expect(totalTax(total)).toBe(10_000 * (900_05 + 900_05));
  });

  it("formats in Indian grouping, not western", () => {
    expect(formatINR(12_345_678)).toBe("₹1,23,456.78");
    expect(formatINRCompact(1_00_00_000_00)).toBe("₹1 Cr");
    expect(formatINRCompact(48_25_000_00)).toBe("₹48.25 L");
  });

  it("absDelta is symmetric", () => {
    expect(absDelta(500, 300)).toBe(absDelta(300, 500));
  });
});

describe("GSTIN validation", () => {
  // Constructed by taking a well-formed 14-char prefix and appending the
  // check digit our own algorithm derives, then asserting the algorithm
  // accepts it — a round-trip rather than a hand-copied constant.
  const prefixes = [
    "27AABCS1429B1Z",
    "29AAACI1195H1Z",
    "33AABCT3518Q1Z",
    "07AAACH7409R1Z",
    "24AAACR5055K1Z",
  ];

  it("round-trips the check digit for well-formed GSTINs", () => {
    for (const prefix of prefixes) {
      const check = computeGstinCheckDigit(prefix);
      expect(check).toBeTruthy();
      const full = prefix + check;
      expect(isValidGstin(full)).toBe(true);
    }
  });

  it("rejects a wrong check digit", () => {
    for (const prefix of prefixes) {
      const correct = computeGstinCheckDigit(prefix)!;
      // Any other character in the set must fail.
      const wrong = correct === "Z" ? "Y" : "Z";
      const result = validateGstin(prefix + wrong);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("BAD_CHECKSUM");
    }
  });

  it("classifies malformed input precisely", () => {
    expect(validateGstin("").error).toBe("EMPTY");
    expect(validateGstin("27AABCS1429B1Z").error).toBe("BAD_LENGTH");
    expect(validateGstin("2XAABCS1429B1ZP").error).toBe("BAD_FORMAT");
    expect(validateGstin("00AABCS1429B1ZP").error).toBe("UNKNOWN_STATE_CODE");
  });

  it("normalises spacing and case before validating", () => {
    const full = "27AABCS1429B1Z" + computeGstinCheckDigit("27AABCS1429B1Z");
    const messy = ` ${full.slice(0, 2)} ${full.slice(2).toLowerCase()} `;
    expect(isValidGstin(messy)).toBe(true);
  });

  it("extracts the PAN, so two registrations of one entity are linkable", () => {
    expect(panFromGstin("27AABCS1429B1ZP")).toBe("AABCS1429B");
  });
});

describe("invoice number canonicalisation", () => {
  it("collapses separators and leading zeros", () => {
    const a = invoiceKeys("INV/2026-27/0091");
    const b = invoiceKeys("inv-2026-27-91");
    expect(a.loose).toBe(b.loose);
  });

  it("keeps genuinely different serials apart", () => {
    // The classic false positive. These are two different invoices.
    const a = invoiceKeys("INV/91");
    const b = invoiceKeys("INV/191");
    expect(a.loose).not.toBe(b.loose);
    expect(a.strict).not.toBe(b.strict);
  });

  it("extracts the numeric tail and alpha prefix", () => {
    const k = invoiceKeys("SBT/GST/2026-27/00457");
    expect(k.numericTail).toBe("457");
    expect(k.alphaPrefix).toBe("SBT");
  });

  it("bounded levenshtein exits early beyond the cap", () => {
    expect(boundedLevenshtein("INV91", "INV91")).toBe(0);
    expect(boundedLevenshtein("INV91", "INV9I")).toBe(1);
    expect(boundedLevenshtein("SHORT", "COMPLETELYDIFFERENT", 2)).toBe(3);
  });
});

describe("date handling", () => {
  it("reads Indian day-first formats", () => {
    expect(parseGstDate("05-04-2026")).toBe("2026-04-05");
    expect(parseGstDate("5/4/2026")).toBe("2026-04-05");
    expect(parseGstDate("05-Apr-2026")).toBe("2026-04-05");
    expect(parseGstDate("2026-04-05")).toBe("2026-04-05");
  });

  it("reads Excel serial dates", () => {
    // 2024-01-01 is serial 45292, so 45387 is 95 days later = 2024-04-05.
    expect(parseGstDate(45292)).toBe("2024-01-01");
    expect(parseGstDate(45387)).toBe("2024-04-05");
  });

  it("rejects impossible dates instead of rolling them forward", () => {
    // A silent roll-forward would corrupt the 180-day and Sec 16(4) clocks.
    expect(parseGstDate("31-02-2026")).toBeNull();
    expect(parseGstDate("32-01-2026")).toBeNull();
    expect(parseGstDate("garbage")).toBeNull();
    expect(parseGstDate("")).toBeNull();
  });

  it("computes the Indian financial year across the April boundary", () => {
    expect(financialYearOf("2026-03-31")).toBe("2025-26");
    expect(financialYearOf("2026-04-01")).toBe("2026-27");
    expect(financialYearOf("2027-03-31")).toBe("2026-27");
  });

  it("derives the Sec 16(4) deadline as 30 November of the following FY", () => {
    expect(sec16_4Deadline("2026-04-05")).toBe("2027-11-30");
    expect(sec16_4Deadline("2027-03-31")).toBe("2027-11-30");
    expect(sec16_4Deadline("2027-04-01")).toBe("2028-11-30");
  });

  it("day arithmetic is exact across month and year ends", () => {
    expect(daysBetween("2026-01-01", "2026-12-31")).toBe(364);
    expect(addDays("2026-02-27", 2)).toBe("2026-03-01");
    expect(addDays("2024-02-27", 2)).toBe("2024-02-29");
    expect(daysBetween("2026-04-05", addDays("2026-04-05", 180))).toBe(180);
  });
});

describe("vendor name keys", () => {
  it("ignores legal suffixes when comparing trading names", () => {
    expect(vendorNameKey("Shree Balaji Steel Traders Pvt. Ltd.")).toBe(
      vendorNameKey("SHREE BALAJI STEEL"),
    );
  });
});
