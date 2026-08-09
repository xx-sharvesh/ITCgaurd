import { describe, expect, it } from "vitest";
import { generateDataset } from "../fixtures/generate";
import { runReconciliation } from "../engine/run";
import { totalTax } from "../domain/money";
import { buildPaymentFile, paymentFileCsv } from "./payment-file";
import type { BankDetails } from "../domain/types";

const dataset = generateDataset({ seed: 20260809, lines: 400 });
const run = runReconciliation(dataset.purchases, dataset.gstr2b, {
  asOf: dataset.asOf,
  period: dataset.period,
});

describe("payment file", () => {
  it("never includes a HOLD or ESCALATE decision", () => {
    const held = new Set(
      run.decisions.filter((d) => d.verdict === "HOLD" || d.verdict === "ESCALATE").map((d) => d.supplierGstin),
    );
    expect(held.size, "fixture assumption: expect at least one held/escalated vendor").toBeGreaterThan(0);

    const { rows } = buildPaymentFile(run.decisions, run.matches, {}, run.period);
    const leaked = rows.filter((r) => held.has(r.supplierGstin));
    expect(leaked).toEqual([]);
  });

  it("pays PAY_NET_OF_GST only the taxable value, never the tax component", () => {
    const netOfGst = run.decisions.find((d) => d.verdict === "PAY_NET_OF_GST");
    expect(netOfGst, "fixture assumption: expect at least one PAY_NET_OF_GST decision").toBeDefined();

    const { rows } = buildPaymentFile(run.decisions, run.matches, {}, run.period);
    const row = rows.find((r) => r.supplierGstin === netOfGst!.supplierGstin);
    expect(row).toBeDefined();

    const byId = new Map(run.matches.map((m) => [m.id, m]));
    const expectedTaxable = netOfGst!.matchIds.reduce((s, id) => {
      const p = byId.get(id)?.purchase;
      return s + (p ? p.taxableValue : 0);
    }, 0);
    const expectedTax = netOfGst!.matchIds.reduce((s, id) => {
      const p = byId.get(id)?.purchase;
      return s + (p ? totalTax(p.tax) : 0);
    }, 0);

    expect(row!.amountPaise).toBe(expectedTaxable);
    expect(row!.amountPaise).toBeLessThan(expectedTaxable + expectedTax);
  });

  it("pays PAY decisions the full exposure", () => {
    const payInFull = run.decisions.find((d) => d.verdict === "PAY" && d.exposure > 0);
    expect(payInFull).toBeDefined();

    const { rows } = buildPaymentFile(run.decisions, run.matches, {}, run.period);
    const row = rows.find((r) => r.supplierGstin === payInFull!.supplierGstin);
    expect(row!.amountPaise).toBe(payInFull!.exposure);
  });

  it("flags a payable vendor with no bank details as NEEDS BANK DETAILS, never a blank pretending to be valid", () => {
    const { rows } = buildPaymentFile(run.decisions, run.matches, {}, run.period);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.status).toBe("NEEDS BANK DETAILS");
      expect(r.accountNumber).toBe("");
      expect(r.ifsc).toBe("");
    }
  });

  it("marks a vendor READY once bank details are supplied, and uses the ledger's account holder name", () => {
    const target = run.decisions.find((d) => d.verdict === "PAY" || d.verdict === "PAY_NET_OF_GST")!;
    const bankDirectory: Record<string, BankDetails> = {
      [target.supplierGstin]: { accountNumber: "000123456789", ifsc: "HDFC0001234", accountHolder: "Test Traders Pvt Ltd" },
    };

    const { rows } = buildPaymentFile(run.decisions, run.matches, bankDirectory, run.period);
    const row = rows.find((r) => r.supplierGstin === target.supplierGstin)!;

    expect(row.status).toBe("READY");
    expect(row.accountNumber).toBe("000123456789");
    expect(row.ifsc).toBe("HDFC0001234");
    expect(row.accountHolder).toBe("Test Traders Pvt Ltd");
  });

  it("falls back to the supplier's registered name when the bank record has no account-holder name", () => {
    const target = run.decisions.find((d) => d.verdict === "PAY" || d.verdict === "PAY_NET_OF_GST")!;
    const bankDirectory: Record<string, BankDetails> = {
      [target.supplierGstin]: { accountNumber: "000999", ifsc: "ICIC0000999" },
    };

    const { rows } = buildPaymentFile(run.decisions, run.matches, bankDirectory, run.period);
    const row = rows.find((r) => r.supplierGstin === target.supplierGstin)!;
    expect(row.accountHolder).toBe(target.supplierName);
  });

  it("routes at or above two lakh to RTGS, below it to NEFT", () => {
    const { rows } = buildPaymentFile(run.decisions, run.matches, {}, run.period);
    for (const r of rows) {
      if (r.amountPaise >= 20_000_000) expect(r.mode).toBe("RTGS");
      else expect(r.mode).toBe("NEFT");
    }
    expect(rows.some((r) => r.mode === "RTGS")).toBe(true);
    expect(rows.some((r) => r.mode === "NEFT")).toBe(true);
  });

  it("orders the largest payment first, same as the Pay/Hold screen", () => {
    const { rows } = buildPaymentFile(run.decisions, run.matches, {}, run.period);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].amountPaise).toBeGreaterThanOrEqual(rows[i].amountPaise);
    }
  });

  it("the total ties exactly to the sum of its own rows", () => {
    const summary = buildPaymentFile(run.decisions, run.matches, {}, run.period);
    const summed = summary.rows.reduce((s, r) => s + r.amountPaise, 0);
    expect(summary.totalPaise).toBe(summed);
    expect(summary.readyCount + summary.needsBankDetailsCount).toBe(summary.rows.length);
  });

  it("produces a CSV with a real numeric-looking amount column and no leaked internals", () => {
    const summary = buildPaymentFile(run.decisions, run.matches, {}, run.period);
    const csv = paymentFileCsv(summary);
    expect(csv).toContain("Beneficiary Name");
    expect(csv).toContain("IFSC");
    expect(csv).toContain("NEEDS BANK DETAILS");
    expect(csv).not.toMatch(/undefined|NaN/);
  });
});
