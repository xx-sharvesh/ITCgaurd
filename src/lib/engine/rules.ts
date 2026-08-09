/**
 * The statutory rules engine.
 *
 * Turns match results into priced, cited, actionable exposure. Every finding
 * names the provision it comes from, because the person who checks our work is
 * a Chartered Accountant who will not accept "the software said so".
 *
 * Determinism: the caller supplies `asOf`. Nothing in here reads the clock.
 * A run over July 2026 must produce identical output whether it executes in
 * August 2026 or in a regression test three years later.
 */

import type {
  ISODate,
  MatchResult,
  Paise,
  RiskFinding,
  RiskRuleId,
  Severity,
} from "../domain/types";
import { totalTax } from "../domain/money";
import { validateGstin } from "../domain/gstin";
import { addDays, daysBetween, financialYearOf, sec16_4Deadline } from "../domain/normalize";
import { DEFAULT_STATUTORY_CONFIG, type StatutoryConfig } from "./config";

export interface RuleContext {
  /** Reference date for every clock in this run. */
  asOf: ISODate;
  statutory?: StatutoryConfig;
  /**
   * Whether written agreements exist with MSME suppliers, which sets the
   * Sec 43B(h) window at 45 days rather than 15. Defaults to true because
   * purchase orders are near-universal in this segment; surfaced in the UI as
   * an explicit assumption rather than buried.
   */
  msmeWrittenAgreement?: boolean;
}

const SEVERITY_OF: Record<RiskRuleId, Severity> = {
  SEC_16_2_AA_NOT_IN_2B: "CRITICAL",
  ITC_MARKED_INELIGIBLE: "HIGH",
  RULE_37_180_DAY: "HIGH",
  RULE_37A_SUPPLIER_3B_UNFILED: "HIGH",
  SEC_16_4_TIME_BARRED: "CRITICAL",
  VALUE_MISMATCH: "MEDIUM",
  IN_2B_NOT_IN_BOOKS: "LOW",
  SEC_43B_H_MSME_OVERDUE: "HIGH",
  INVALID_OR_CANCELLED_GSTIN: "MEDIUM",
};

export const CITATIONS: Record<RiskRuleId, string> = {
  SEC_16_2_AA_NOT_IN_2B: "Sec 16(2)(aa) CGST Act r/w Rule 36(4)",
  ITC_MARKED_INELIGIBLE: "Sec 17(5) CGST Act — as flagged in GSTR-2B",
  RULE_37_180_DAY: "Second proviso to Sec 16(2) r/w Rule 37 CGST Rules",
  RULE_37A_SUPPLIER_3B_UNFILED: "Rule 37A CGST Rules",
  SEC_16_4_TIME_BARRED: "Sec 16(4) CGST Act",
  VALUE_MISMATCH: "Sec 16(2)(a) CGST Act — credit limited to the tax charged",
  IN_2B_NOT_IN_BOOKS: "Sec 16(2)(aa) CGST Act — unclaimed eligible credit",
  SEC_43B_H_MSME_OVERDUE: "Sec 43B(h) Income-tax Act r/w Sec 15 MSMED Act",
  INVALID_OR_CANCELLED_GSTIN: "Sec 16(2)(a) CGST Act — valid tax invoice required",
};

let counter = 0;
function nextId(rule: RiskRuleId): string {
  counter += 1;
  return `f-${rule.toLowerCase()}-${counter}`;
}

/** Reset between runs so ids are stable in tests. */
export function resetFindingIds(): void {
  counter = 0;
}

export function evaluateRules(matches: MatchResult[], ctx: RuleContext): RiskFinding[] {
  const cfg = ctx.statutory ?? DEFAULT_STATUTORY_CONFIG;
  const findings: RiskFinding[] = [];
  resetFindingIds();

  for (const m of matches) {
    findings.push(...rulesForMatch(m, ctx, cfg));
  }

  // Largest exposure first — the cockpit shows the top handful, and the top
  // handful must be where the money actually is.
  findings.sort((a, b) => {
    const sev = severityRank(a.severity) - severityRank(b.severity);
    if (sev !== 0) return sev;
    return b.amountAtRisk - a.amountAtRisk;
  });

  return findings;
}

function severityRank(s: Severity): number {
  return { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }[s];
}

function rulesForMatch(m: MatchResult, ctx: RuleContext, cfg: StatutoryConfig): RiskFinding[] {
  const out: RiskFinding[] = [];
  const p = m.purchase;
  const g = m.gstr2b;

  const supplierGstin = p?.supplierGstin ?? g?.supplierGstin ?? "";
  const supplierName = p?.supplierName ?? g?.supplierName ?? "Unknown supplier";
  const base = { supplierGstin, supplierName, matchIds: [m.id] };

  // -- Sec 16(2)(aa): claimed in books, absent from the portal ---------------
  if (m.tier === "BOOKS_ONLY" && p) {
    const amount = totalTax(p.tax);
    out.push({
      ...base,
      id: nextId("SEC_16_2_AA_NOT_IN_2B"),
      rule: "SEC_16_2_AA_NOT_IN_2B",
      severity: SEVERITY_OF.SEC_16_2_AA_NOT_IN_2B,
      citation: CITATIONS.SEC_16_2_AA_NOT_IN_2B,
      headline: `${supplierName} has not reported invoice ${p.invoiceNumber}`,
      explanation:
        "Credit is available only where the supplier has furnished the invoice and it appears in your GSTR-2B. " +
        "This document is in your books but not in the statement, so the credit is not presently claimable. " +
        "Provisional credit was withdrawn entirely with effect from 1 January 2022 — there is no 5% buffer to fall back on.",
      amountAtRisk: amount,
      deadline: sec16_4Deadline(p.invoiceDate),
      recommendedAction: "CHASE_VENDOR",
    });
  }

  // -- Portal itself says the credit is not available ------------------------
  if (g && g.itcAvailable === "N") {
    const amount = totalTax(g.tax);
    out.push({
      ...base,
      id: nextId("ITC_MARKED_INELIGIBLE"),
      rule: "ITC_MARKED_INELIGIBLE",
      severity: SEVERITY_OF.ITC_MARKED_INELIGIBLE,
      citation: CITATIONS.ITC_MARKED_INELIGIBLE,
      headline: `GSTR-2B marks ${g.invoiceNumber} as ineligible credit`,
      explanation:
        `The portal has flagged this document as ineligible${g.itcUnavailableReason ? ` (${g.itcUnavailableReason})` : ""}. ` +
        "Claiming it anyway widens the gap between your GSTR-3B and your GSTR-2B, which is exactly the condition " +
        "that triggers an automated DRC-01C intimation under Rule 88D.",
      amountAtRisk: amount,
      recommendedAction: p ? "CORRECT_BOOKS" : "VERIFY_VENDOR",
    });
  }

  // -- Rule 37: supplier unpaid beyond 180 days ------------------------------
  // Credit notes are excluded: they reduce credit rather than create a payment
  // obligation, so there is nothing to reverse and nothing to pay late.
  if (p && !p.reverseCharge && p.documentType !== "CREDIT_NOTE") {
    const dueDate = addDays(p.invoiceDate, cfg.rule37PaymentDays);
    const paid = Boolean(p.paymentDate);
    const paidLate = paid && daysBetween(p.invoiceDate, p.paymentDate!) > cfg.rule37PaymentDays;
    const unpaidOverdue = !paid && daysBetween(p.invoiceDate, ctx.asOf) > cfg.rule37PaymentDays;

    if (paidLate || unpaidOverdue) {
      const credit = totalTax(p.tax);
      const daysOverdue = paid
        ? daysBetween(p.invoiceDate, p.paymentDate!) - cfg.rule37PaymentDays
        : daysBetween(p.invoiceDate, ctx.asOf) - cfg.rule37PaymentDays;
      const interest = interestOn(credit, daysOverdue, cfg.interestRatePerAnnum);

      out.push({
        ...base,
        id: nextId("RULE_37_180_DAY"),
        rule: "RULE_37_180_DAY",
        severity: SEVERITY_OF.RULE_37_180_DAY,
        citation: CITATIONS.RULE_37_180_DAY,
        headline: `Invoice ${p.invoiceNumber} unpaid ${daysOverdue} days past the 180-day limit`,
        explanation:
          "Where the supplier is not paid within 180 days of the invoice date, the credit already taken must be " +
          "added back to output tax with interest. The credit can be re-claimed in the period the payment is " +
          `finally made, so the permanent loss is the interest — approximately ${(cfg.interestRatePerAnnum * 100).toFixed(0)}% per annum on the credit.`,
        amountAtRisk: credit + interest,
        deadline: dueDate,
        recommendedAction: paid ? "REVERSE_CREDIT" : "RELEASE_PAYMENT",
      });
    }
  }

  // -- Rule 37A: supplier filed GSTR-1 but not GSTR-3B -----------------------
  // The insidious one. The invoice IS in 2B, so every naive tool reports it as
  // clean, and the reversal lands a year later with interest.
  // A credit note carries negative tax, so there is no credit to claw back.
  if (g && g.supplierGstr3bFiled === false && g.documentType !== "CREDIT_NOTE" && totalTax(g.tax) > 0) {
    const amount = totalTax(g.tax);
    const fy = financialYearOf(g.invoiceDate);
    const fyEndYear = Number(fy.slice(0, 4)) + 1;
    const supplierDeadline = `${fyEndYear}-${pad(cfg.rule37aSupplierDeadlineMonth)}-${pad(cfg.rule37aSupplierDeadlineDay)}`;
    const reversalDeadline = `${fyEndYear}-${pad(cfg.rule37aReversalMonth)}-${pad(cfg.rule37aReversalDay)}`;

    out.push({
      ...base,
      id: nextId("RULE_37A_SUPPLIER_3B_UNFILED"),
      rule: "RULE_37A_SUPPLIER_3B_UNFILED",
      severity: SEVERITY_OF.RULE_37A_SUPPLIER_3B_UNFILED,
      citation: CITATIONS.RULE_37A_SUPPLIER_3B_UNFILED,
      headline: `${supplierName} filed GSTR-1 but not GSTR-3B for ${g.invoiceNumber}`,
      explanation:
        "This document appears in your GSTR-2B, so a routine reconciliation shows it as clean. It is not. " +
        `The supplier has declared the invoice but has not paid the tax. If they have still not filed GSTR-3B by ` +
        `${supplierDeadline}, you are required to reverse this credit by ${reversalDeadline}, with interest if you do not.`,
      amountAtRisk: amount,
      deadline: reversalDeadline,
      recommendedAction: "CHASE_VENDOR",
    });
  }

  // -- Sec 16(4): the claim window closes ------------------------------------
  if (p) {
    const deadline = sec16_4Deadline(p.invoiceDate);
    const daysLeft = daysBetween(ctx.asOf, deadline);
    const unclaimed = m.tier === "BOOKS_ONLY";

    // Only a risk while the credit has not actually landed. A matched, clean
    // line needs no warning simply because November is approaching.
    if (unclaimed && daysLeft <= 120) {
      const amount = totalTax(p.tax);
      const expired = daysLeft < 0;
      out.push({
        ...base,
        id: nextId("SEC_16_4_TIME_BARRED"),
        rule: "SEC_16_4_TIME_BARRED",
        severity: expired ? "CRITICAL" : SEVERITY_OF.SEC_16_4_TIME_BARRED,
        citation: CITATIONS.SEC_16_4_TIME_BARRED,
        headline: expired
          ? `Credit on ${p.invoiceNumber} is time-barred — permanently lost`
          : `Only ${daysLeft} days left to claim credit on ${p.invoiceNumber}`,
        explanation: expired
          ? "The statutory window to take this credit has closed. It cannot be claimed in any later return and " +
            "is a permanent cost. It is recorded here so it can be written off knowingly and so the vendor's " +
            "risk score reflects what it cost you."
          : `Credit for an invoice must be taken by 30 November following the end of the financial year to which ` +
            `it relates. This invoice falls in FY ${financialYearOf(p.invoiceDate)}, so the window closes on ${deadline}. ` +
            "After that the credit is gone for good, whatever the vendor does.",
        amountAtRisk: amount,
        deadline,
        recommendedAction: expired ? "CORRECT_BOOKS" : "CHASE_VENDOR",
      });
    }
  }

  // -- Values disagree between books and portal ------------------------------
  if (m.tier === "MISMATCH" && p && g && m.deltas.length > 0) {
    // Credit is capped at what the supplier actually declared. Over-claiming
    // is the exposure; under-claiming is merely money left behind.
    const overclaim = Math.max(0, totalTax(p.tax) - totalTax(g.tax));
    const underclaim = Math.max(0, totalTax(g.tax) - totalTax(p.tax));
    const fields = m.deltas.map((d) => d.field).join(", ");

    out.push({
      ...base,
      id: nextId("VALUE_MISMATCH"),
      rule: "VALUE_MISMATCH",
      severity: overclaim > 0 ? "HIGH" : "LOW",
      citation: CITATIONS.VALUE_MISMATCH,
      headline:
        overclaim > 0
          ? `Books claim more than ${supplierName} declared on ${p.invoiceNumber}`
          : `${supplierName} declared more than booked on ${p.invoiceNumber}`,
      explanation:
        `The two records disagree on: ${fields}. ` +
        (overclaim > 0
          ? "Credit is limited to the tax actually charged and declared by the supplier, so the excess is not " +
            "available and will show up as a 3B-versus-2B gap."
          : "The supplier has declared more than you have booked, so there is credit here you are not taking. " +
            "Verify the document and correct the books to claim it."),
      amountAtRisk: overclaim > 0 ? overclaim : underclaim,
      recommendedAction: overclaim > 0 ? "CORRECT_BOOKS" : "CLAIM_NOW",
    });
  }

  // -- In the portal, not in the books: unclaimed credit ---------------------
  if (m.tier === "GSTR2B_ONLY" && g && g.itcAvailable === "Y") {
    const amount = totalTax(g.tax);
    out.push({
      ...base,
      id: nextId("IN_2B_NOT_IN_BOOKS"),
      rule: "IN_2B_NOT_IN_BOOKS",
      severity: SEVERITY_OF.IN_2B_NOT_IN_BOOKS,
      citation: CITATIONS.IN_2B_NOT_IN_BOOKS,
      headline: `Eligible credit on ${g.invoiceNumber} is not in your books`,
      explanation:
        `${supplierName} has declared this document and the portal shows the credit as available, but there is no ` +
        "corresponding entry in the purchase register. Either the invoice was never booked, or it was booked under " +
        "a different reference. This is money you are entitled to and are not taking.",
      amountAtRisk: amount,
      deadline: sec16_4Deadline(g.invoiceDate),
      recommendedAction: "CLAIM_NOW",
    });
  }

  // -- Sec 43B(h): MSME supplier unpaid --------------------------------------
  // Income-tax, not GST. It belongs here because it is the constraint that
  // makes "just hold the payment" the wrong answer, and no GST tool models it.
  // Credit notes excluded for the same reason as Rule 37 — a credit note is
  // money owed *to* us, so it cannot be an overdue payment to the supplier.
  if (
    p &&
    (p.msmeStatus === "MICRO" || p.msmeStatus === "SMALL") &&
    p.documentType !== "CREDIT_NOTE" &&
    p.taxableValue > 0
  ) {
    const limit = ctx.msmeWrittenAgreement === false
      ? cfg.msmePaymentDaysNoAgreement
      : cfg.msmePaymentDaysWithAgreement;
    const dueDate = addDays(p.invoiceDate, limit);
    const paid = Boolean(p.paymentDate);
    const daysElapsed = daysBetween(p.invoiceDate, paid ? p.paymentDate! : ctx.asOf);

    if (daysElapsed > limit) {
      // The cost is the deduction deferred to a later year, valued at the
      // effective tax rate on the expense — not on the tax component.
      const disallowance = Math.round(p.taxableValue * cfg.effectiveTaxRate);
      out.push({
        ...base,
        id: nextId("SEC_43B_H_MSME_OVERDUE"),
        rule: "SEC_43B_H_MSME_OVERDUE",
        severity: SEVERITY_OF.SEC_43B_H_MSME_OVERDUE,
        citation: CITATIONS.SEC_43B_H_MSME_OVERDUE,
        headline: `${supplierName} is a registered ${p.msmeStatus.toLowerCase()} enterprise, unpaid ${daysElapsed} days`,
        explanation:
          `Payment to a registered micro or small enterprise must be made within ${limit} days. Beyond that, the ` +
          "expense is not deductible in this year and is deferred to the year of actual payment. " +
          `At an effective rate of ${(cfg.effectiveTaxRate * 100).toFixed(0)}%, deferring this deduction costs roughly the amount shown. ` +
          "Note this pulls against any GST-driven decision to withhold payment.",
        amountAtRisk: disallowance,
        deadline: dueDate,
        recommendedAction: "RELEASE_PAYMENT",
      });
    }
  }

  // -- Structurally invalid supplier GSTIN -----------------------------------
  if (p && m.tier === "BOOKS_ONLY") {
    const v = validateGstin(p.supplierGstin);
    if (!v.valid) {
      out.push({
        ...base,
        id: nextId("INVALID_OR_CANCELLED_GSTIN"),
        rule: "INVALID_OR_CANCELLED_GSTIN",
        severity: SEVERITY_OF.INVALID_OR_CANCELLED_GSTIN,
        citation: CITATIONS.INVALID_OR_CANCELLED_GSTIN,
        headline: `Supplier GSTIN on ${p.invoiceNumber} is not a valid GSTIN`,
        explanation:
          "The GSTIN recorded against this invoice fails structural validation, so no reconciliation against the " +
          "portal is possible for it. Most often this is a transcription error in the purchase register rather " +
          "than a problem with the vendor — correct the master before chasing the supplier.",
        amountAtRisk: totalTax(p.tax),
        recommendedAction: "CORRECT_BOOKS",
      });
    }
  }

  return out;
}

/** Simple interest, day-count on a 365-day year. */
function interestOn(principal: Paise, days: number, ratePerAnnum: number): Paise {
  if (days <= 0) return 0;
  return Math.round((principal * ratePerAnnum * days) / 365);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
