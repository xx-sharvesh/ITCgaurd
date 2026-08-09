/**
 * The bulk payment file — where a recommendation turns into an action.
 *
 * Every other screen in this product stops at "here is what to do." This is
 * the one export that closes the loop: a beneficiary file a finance team can
 * hand straight to their bank's bulk NEFT/RTGS upload, instead of opening
 * netbanking and keying in thirty vendors one at a time.
 *
 * Deliberately bank-agnostic rather than templated to one bank's proprietary
 * format (HDFC, ICICI and Axis each want different column layouts, and
 * guessing one we haven't verified would be worse than being generic). This
 * produces the columns every bulk-upload template needs at minimum —
 * beneficiary name, account, IFSC, amount, mode, narration — so a finance
 * team can either upload it as-is where a generic CSV import is accepted, or
 * paste the columns straight into their bank's specific template in seconds
 * instead of retyping from the Pay/Hold screen by hand.
 *
 * Only ever includes what the pay/hold engine actually approved for release
 * this run: PAY in full, and the taxable-value portion of PAY_NET_OF_GST.
 * HOLD and ESCALATE never appear here — this file cannot pay something the
 * engine just told you not to.
 */

import type { BankDetails, MatchResult, Paise, PayHoldDecision } from "../domain/types";
import { paiseToRupees } from "../domain/money";
import { toCsv } from "./csv";

/** RBI's conventional NEFT/RTGS split: ₹2,00,000 and above defaults to RTGS. */
const RTGS_THRESHOLD_PAISE = 20_000_000;

export interface PaymentFileRow {
  supplierGstin: string;
  supplierName: string;
  verdict: "PAY" | "PAY_NET_OF_GST";
  accountHolder: string;
  accountNumber: string;
  ifsc: string;
  amountPaise: Paise;
  mode: "NEFT" | "RTGS";
  narration: string;
  /** READY means the row can go straight into a bank upload. */
  status: "READY" | "NEEDS BANK DETAILS";
}

export interface PaymentFileSummary {
  rows: PaymentFileRow[];
  totalPaise: Paise;
  readyCount: number;
  needsBankDetailsCount: number;
}

/**
 * Sum only the taxable-value portion of a decision's matched invoices — the
 * part PAY_NET_OF_GST actually releases, holding back the tax.
 */
function taxableOnlyAmount(matchIds: string[], matches: MatchResult[]): Paise {
  const byId = new Map(matches.map((m) => [m.id, m]));
  let sum = 0;
  for (const id of matchIds) {
    const purchase = byId.get(id)?.purchase;
    if (purchase) sum += purchase.taxableValue;
  }
  return sum;
}

export function buildPaymentFile(
  decisions: PayHoldDecision[],
  matches: MatchResult[],
  bankDirectory: Record<string, BankDetails>,
  period: string,
): PaymentFileSummary {
  const rows: PaymentFileRow[] = [];

  for (const d of decisions) {
    if (d.verdict !== "PAY" && d.verdict !== "PAY_NET_OF_GST") continue;

    const amountPaise = d.verdict === "PAY" ? d.exposure : taxableOnlyAmount(d.matchIds, matches);
    if (amountPaise <= 0) continue;

    const bank = bankDirectory[d.supplierGstin];

    rows.push({
      supplierGstin: d.supplierGstin,
      supplierName: d.supplierName,
      verdict: d.verdict,
      accountHolder: bank?.accountHolder || d.supplierName,
      accountNumber: bank?.accountNumber ?? "",
      ifsc: bank?.ifsc ?? "",
      amountPaise,
      mode: amountPaise >= RTGS_THRESHOLD_PAISE ? "RTGS" : "NEFT",
      narration:
        d.verdict === "PAY_NET_OF_GST"
          ? `${period} settlement, tax withheld pending GSTR-2B`
          : `${period} GST reconciliation release`,
      status: bank ? "READY" : "NEEDS BANK DETAILS",
    });
  }

  // Largest payment first — the same "work it top-down" ordering as the
  // Pay/Hold screen itself.
  rows.sort((a, b) => b.amountPaise - a.amountPaise);

  return {
    rows,
    totalPaise: rows.reduce((s, r) => s + r.amountPaise, 0),
    readyCount: rows.filter((r) => r.status === "READY").length,
    needsBankDetailsCount: rows.filter((r) => r.status === "NEEDS BANK DETAILS").length,
  };
}

export function paymentFileCsv(summary: PaymentFileSummary): string {
  return toCsv(
    summary.rows.map((r) => ({
      "Beneficiary Name": r.accountHolder,
      "Account Number": r.accountNumber,
      "IFSC": r.ifsc,
      "Amount (INR)": paiseToRupees(r.amountPaise).toFixed(2),
      Mode: r.mode,
      Narration: r.narration,
      "Supplier GSTIN": r.supplierGstin,
      Status: r.status,
    })),
  );
}

export function paymentFileFilename(period: string): string {
  return `payment-release-${period}.csv`;
}
