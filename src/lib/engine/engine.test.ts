import { describe, expect, it } from "vitest";
import { generateDataset, defectCensus } from "../fixtures/generate";
import { GOLDEN_PAIRS } from "../fixtures/golden";
import { totalTax } from "../domain/money";
import type { VendorPeriodSnapshot } from "../domain/types";
import { IDENTITY_THRESHOLD, invoiceSimilarity, reconcile } from "./match";
import { runReconciliation, snapshotVendors } from "./run";

const dataset = generateDataset({ seed: 20260809, lines: 600 });

describe("fixture integrity", () => {
  it("is deterministic — same seed, identical output", () => {
    const a = generateDataset({ seed: 42, lines: 120 });
    const b = generateDataset({ seed: 42, lines: 120 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("differs across seeds, so tests are not accidentally trivial", () => {
    const a = generateDataset({ seed: 1, lines: 120 });
    const b = generateDataset({ seed: 2, lines: 120 });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("seeds every defect class the engine claims to catch", () => {
    const census = defectCensus(dataset);
    const required = [
      "CLEAN", "FORMAT_DRIFT", "ROUNDING", "DATE_DRIFT", "VALUE_MISMATCH",
      "RATE_MISMATCH", "BOOKS_ONLY", "GSTR2B_ONLY", "CREDIT_NOTE",
      "INELIGIBLE", "RULE_37A", "BAD_GSTIN", "REVERSE_CHARGE", "MUST_NOT_MATCH",
    ];
    for (const label of required) {
      expect(census[label] ?? 0, `defect class ${label} missing from fixture`).toBeGreaterThan(0);
    }
  });
});

describe("invoice-number ground truth", () => {
  /**
   * The golden set is hand-labelled against the full tier ladder, not any one
   * tier. Some real pairs are only reachable after stripping the financial
   * year, and one is only reachable by edit distance — those tiers exist
   * precisely because those cases exist. What matters is:
   *
   *   same-pairs      → reach a non-zero score somewhere on the ladder
   *   different-pairs → never reach IDENTITY_THRESHOLD, so they can only ever
   *                     pair when the amounts independently agree
   *
   * The second assertion is the false-positive guard for the normaliser.
   */
  it("reaches every hand-labelled same-pair somewhere on the ladder", () => {
    const failures = GOLDEN_PAIRS.filter((p) => p.same).filter(
      (p) => invoiceSimilarity(p.a, p.b).score === 0,
    );
    expect(failures.map((f) => `${f.a} vs ${f.b} — unreachable (${f.why})`)).toEqual([]);
  });

  it("never lets a different-pair establish identity on its own", () => {
    const overreach = GOLDEN_PAIRS.filter((p) => !p.same)
      .map((p) => ({ p, sim: invoiceSimilarity(p.a, p.b) }))
      .filter(({ sim }) => sim.score >= IDENTITY_THRESHOLD);

    expect(
      overreach.map(({ p, sim }) => `${p.a} vs ${p.b} scored ${sim.score} (${p.why})`),
    ).toEqual([]);
  });

  it("scores identical numbers above cosmetically-drifted ones", () => {
    const identical = invoiceSimilarity("INV/2026-27/0091", "INV/2026-27/0091").score;
    const drifted = invoiceSimilarity("INV/2026-27/0091", "inv-2026-27-91").score;
    const unrelated = invoiceSimilarity("INV/2026-27/0091", "PQR/2026-27/0455").score;

    expect(identical).toBe(1);
    expect(drifted).toBeGreaterThan(0.9);
    expect(unrelated).toBe(0);
  });

  it("keeps adjacent serials below the identity threshold", () => {
    // The false match this suite caught in the wild: two real invoices from
    // one vendor, one character apart.
    for (const [a, b] of [
      ["SCS/2026-27/0185", "SCS/2026-27/0188"],
      ["INV/91", "INV/191"],
      ["2026/001", "2026/010"],
    ]) {
      expect(invoiceSimilarity(a, b).score, `${a} vs ${b}`).toBeLessThan(IDENTITY_THRESHOLD);
    }
  });
});

describe("matching engine", () => {
  const matches = reconcile(dataset.purchases, dataset.gstr2b);

  it("accounts for every input line exactly once", () => {
    const purchaseIds = new Set<string>();
    const gstr2bIds = new Set<string>();

    for (const m of matches) {
      if (m.purchase) {
        expect(purchaseIds.has(m.purchase.id), `purchase ${m.purchase.id} appears twice`).toBe(false);
        purchaseIds.add(m.purchase.id);
      }
      if (m.gstr2b) {
        expect(gstr2bIds.has(m.gstr2b.id), `2B row ${m.gstr2b.id} appears twice`).toBe(false);
        gstr2bIds.add(m.gstr2b.id);
      }
    }

    expect(purchaseIds.size).toBe(dataset.purchases.length);
    expect(gstr2bIds.size).toBe(dataset.gstr2b.length);
  });

  /**
   * THE GATE. A false match tells a CFO their credit is safe when it is not.
   * This assertion is allowed zero exceptions; if it ever fails, the matcher
   * ships nothing until it passes again.
   */
  it("produces ZERO false matches against ground truth", () => {
    const truthByPurchase = new Map(
      dataset.expected.filter((e) => e.purchaseId).map((e) => [e.purchaseId!, e]),
    );

    const falseMatches: string[] = [];

    for (const m of matches) {
      if (!m.purchase || !m.gstr2b) continue;
      const truth = truthByPurchase.get(m.purchase.id);
      if (!truth) continue;

      if (!truth.shouldMatch) {
        falseMatches.push(
          `${m.purchase.id} (${m.purchase.invoiceNumber}) wrongly paired with ${m.gstr2b.id} (${m.gstr2b.invoiceNumber}) — ${truth.note}`,
        );
        continue;
      }

      if (truth.gstr2bId && truth.gstr2bId !== m.gstr2b.id) {
        falseMatches.push(
          `${m.purchase.id} (${m.purchase.invoiceNumber}) paired with the WRONG counterpart ${m.gstr2b.id} (${m.gstr2b.invoiceNumber}); expected ${truth.gstr2bId} — ${truth.note}`,
        );
      }
    }

    expect(falseMatches).toEqual([]);
  });

  it("matches the documents that genuinely correspond", () => {
    const shouldMatch = dataset.expected.filter((e) => e.shouldMatch && e.purchaseId && e.gstr2bId);
    const matchedPairs = new Set(
      matches.filter((m) => m.purchase && m.gstr2b).map((m) => `${m.purchase!.id}|${m.gstr2b!.id}`),
    );

    const missed = shouldMatch.filter((e) => !matchedPairs.has(`${e.purchaseId}|${e.gstr2bId}`));
    const recall = 1 - missed.length / shouldMatch.length;

    // A missed match costs ninety seconds of review; a false match costs the
    // credit. So recall is held to a high but non-absolute bar while the
    // false-positive gate above is absolute.
    expect(recall, `missed ${missed.length} of ${shouldMatch.length}: ${missed.slice(0, 5).map((m) => m.note).join("; ")}`)
      .toBeGreaterThan(0.97);
  });

  it("never pairs a credit note with an invoice", () => {
    const crossed = matches.filter(
      (m) => m.purchase && m.gstr2b && m.purchase.documentType !== m.gstr2b.documentType,
    );
    expect(crossed).toEqual([]);
  });

  it("resolves the overwhelming majority without human review", () => {
    const auto = matches.filter((m) => m.tier === "EXACT" || m.tier === "TOLERANT").length;
    const fuzzy = matches.filter((m) => m.tier === "FUZZY").length;

    // The product promise: under 2% of lines reach a person as ambiguous.
    expect(fuzzy / matches.length).toBeLessThan(0.02);
    expect(auto / matches.length).toBeGreaterThan(0.6);
  });

  it("is independent of input ordering", () => {
    const shuffled = [...dataset.purchases].reverse();
    const shuffled2b = [...dataset.gstr2b].reverse();
    const other = reconcile(shuffled, shuffled2b);

    const key = (ms: typeof matches) =>
      ms
        .filter((m) => m.purchase && m.gstr2b)
        .map((m) => `${m.purchase!.id}|${m.gstr2b!.id}`)
        .sort()
        .join(",");

    expect(key(other)).toBe(key(matches));
  });
});

describe("money conservation", () => {
  const run = runReconciliation(dataset.purchases, dataset.gstr2b, {
    asOf: dataset.asOf,
    period: dataset.period,
  });

  /**
   * Every rupee of book credit must be either matched or unmatched. There is
   * no third place for it to go. If this fails the engine has lost or
   * duplicated a line, and no downstream number can be trusted.
   */
  it("ties books ITC to matched plus unmatched, to the paise", () => {
    const t = run.totals;
    expect(t.matchedItc + t.booksOnlyItc).toBe(t.booksItc);
    expect(t.balanced).toBe(true);
    expect(t.imbalanceNote).toBeUndefined();
  });

  it("control totals equal a direct sum of the source files", () => {
    const booksDirect = dataset.purchases.reduce((s, p) => s + totalTax(p.tax), 0);
    const portalDirect = dataset.gstr2b.reduce((s, g) => s + totalTax(g.tax), 0);
    expect(run.totals.booksItc).toBe(booksDirect);
    expect(run.totals.gstr2bItc).toBe(portalDirect);
  });

  it("every amount in the system is an integer number of paise", () => {
    const nonInteger: string[] = [];
    for (const f of run.findings) {
      if (!Number.isInteger(f.amountAtRisk)) nonInteger.push(`${f.id}: ${f.amountAtRisk}`);
    }
    for (const d of run.decisions) {
      if (!Number.isInteger(d.costOfPaying)) nonInteger.push(`${d.supplierGstin} pay: ${d.costOfPaying}`);
      if (!Number.isInteger(d.costOfHolding)) nonInteger.push(`${d.supplierGstin} hold: ${d.costOfHolding}`);
      if (!Number.isInteger(d.exposure)) nonInteger.push(`${d.supplierGstin} exposure: ${d.exposure}`);
    }
    expect(nonInteger).toEqual([]);
  });
});

describe("statutory rules", () => {
  const run = runReconciliation(dataset.purchases, dataset.gstr2b, {
    asOf: dataset.asOf,
    period: dataset.period,
  });

  it("raises the rules the fixture deliberately seeded", () => {
    const rules = new Set(run.findings.map((f) => f.rule));
    for (const expected of [
      "SEC_16_2_AA_NOT_IN_2B",
      "RULE_37A_SUPPLIER_3B_UNFILED",
      "RULE_37_180_DAY",
      "ITC_MARKED_INELIGIBLE",
      "IN_2B_NOT_IN_BOOKS",
      "SEC_43B_H_MSME_OVERDUE",
      "INVALID_OR_CANCELLED_GSTIN",
    ]) {
      expect(rules.has(expected as never), `rule ${expected} was never raised`).toBe(true);
    }
  });

  it("cites a provision on every finding", () => {
    const uncited = run.findings.filter((f) => !f.citation || f.citation.length < 5);
    expect(uncited).toEqual([]);
  });

  it("never reports negative exposure", () => {
    const negative = run.findings.filter((f) => f.amountAtRisk < 0);
    expect(negative.map((f) => `${f.rule} ${f.amountAtRisk}`)).toEqual([]);
  });

  it("excludes unclaimed credit from the headline at-risk figure", () => {
    // Credit left behind is an opportunity, not an exposure. Folding the two
    // together would inflate the number the CFO repeats to their board.
    const unclaimed = run.findings
      .filter((f) => f.rule === "IN_2B_NOT_IN_BOOKS")
      .reduce((s, f) => s + f.amountAtRisk, 0);
    const all = run.findings.reduce((s, f) => s + f.amountAtRisk, 0);
    expect(run.totalAtRisk).toBe(all - unclaimed);
  });

  it("is deterministic across repeated runs", () => {
    const again = runReconciliation(dataset.purchases, dataset.gstr2b, {
      asOf: dataset.asOf,
      period: dataset.period,
    });
    expect(again.totalAtRisk).toBe(run.totalAtRisk);
    expect(again.findings.length).toBe(run.findings.length);
    expect(again.vendors.map((v) => v.riskScore)).toEqual(run.vendors.map((v) => v.riskScore));
  });
});

describe("pay/hold decisions", () => {
  const run = runReconciliation(dataset.purchases, dataset.gstr2b, {
    asOf: dataset.asOf,
    period: dataset.period,
  });

  it("produces decisions only for vendors with open invoices", () => {
    expect(run.decisions.length).toBeGreaterThan(0);
    for (const d of run.decisions) {
      expect(d.exposure).toBeGreaterThan(0);
      expect(d.matchIds.length).toBeGreaterThan(0);
    }
  });

  it("shows its working on every recommendation", () => {
    for (const d of run.decisions) {
      expect(d.rationale.length, `${d.supplierName} has no rationale`).toBeGreaterThan(0);
    }
  });

  it("exercises more than one verdict across the portfolio", () => {
    const verdicts = new Set(run.decisions.map((d) => d.verdict));
    expect(verdicts.size).toBeGreaterThan(1);
  });
});

describe("vendor history", () => {
  const run = runReconciliation(dataset.purchases, dataset.gstr2b, {
    asOf: dataset.asOf,
    period: dataset.period,
  });

  /**
   * The honest default. A vendor with no prior period on file is NEW, not a
   * silently-assumed STABLE — there is nothing yet to compare against, and
   * claiming otherwise would be inventing a trend from no data.
   */
  it("is NEW for every vendor when no history is supplied, with byte-identical scores to before this feature existed", () => {
    const withoutHistoryOption = runReconciliation(dataset.purchases, dataset.gstr2b, {
      asOf: dataset.asOf,
      period: dataset.period,
    });

    for (const v of run.vendors) {
      expect(v.trend).toBe("NEW");
      expect(v.trendDeltaScore).toBeNull();
      expect(v.historicalMissRate).toBeNull();
      expect(v.periodsOfHistory).toBe(0);
      expect(v.consecutiveFlaggedPeriods).toBe(v.itcAtRisk > 0 ? 1 : 0);
    }

    expect(withoutHistoryOption.vendors.map((v) => v.riskScore)).toEqual(
      run.vendors.map((v) => v.riskScore),
    );
  });

  it("snapshots one row per vendor, matching this run's own numbers exactly", () => {
    const snapshots = snapshotVendors(run);
    expect(snapshots).toHaveLength(run.vendors.length);

    const byGstin = new Map(snapshots.map((s) => [s.gstin, s]));
    for (const v of run.vendors) {
      const s = byGstin.get(v.gstin);
      expect(s, `no snapshot recorded for ${v.name}`).toBeDefined();
      expect(s!.period).toBe(run.period);
      expect(s!.riskScore).toBe(v.riskScore);
      expect(s!.riskBand).toBe(v.riskBand);
      expect(s!.itcExposurePaise).toBe(v.itcExposure);
      expect(s!.itcAtRiskPaise).toBe(v.itcAtRisk);
      expect(s!.booksLineCount).toBe(v.booksLineCount);
      expect(s!.missingFrom2bCount).toBe(v.missingFrom2bCount);
      expect(s!.hadRule37A).toBe(v.findings.includes("RULE_37A_SUPPLIER_3B_UNFILED"));
    }
  });

  it("labels a vendor WORSENING when its score has climbed sharply since the last period on file", () => {
    const risky = run.vendors.find((v) => v.riskScore > 25);
    expect(risky, "fixture assumption: expected an elevated-risk vendor").toBeDefined();

    const withHistory = runReconciliation(dataset.purchases, dataset.gstr2b, {
      asOf: dataset.asOf,
      period: dataset.period,
      vendorHistory: {
        [risky!.gstin]: [
          {
            gstin: risky!.gstin,
            name: risky!.name,
            period: "062026",
            riskScore: 0,
            riskBand: "SAFE",
            itcExposurePaise: risky!.itcExposure,
            itcAtRiskPaise: 0,
            booksLineCount: 10,
            missingFrom2bCount: 0,
            hadRule37A: false,
            recordedAt: "2026-07-01T00:00:00.000Z",
          },
        ],
      },
    });

    const v = withHistory.vendors.find((x) => x.gstin === risky!.gstin)!;
    expect(v.periodsOfHistory).toBe(1);
    expect(v.trendDeltaScore).toBe(v.riskScore - 0);
    expect(v.trend).toBe("WORSENING");
  });

  it("labels a vendor IMPROVING when its score has dropped sharply since the last period on file", () => {
    const clean = run.vendors.find((v) => v.riskScore < 10);
    expect(clean, "fixture assumption: expected a low-risk vendor").toBeDefined();

    const withHistory = runReconciliation(dataset.purchases, dataset.gstr2b, {
      asOf: dataset.asOf,
      period: dataset.period,
      vendorHistory: {
        [clean!.gstin]: [
          {
            gstin: clean!.gstin,
            name: clean!.name,
            period: "062026",
            riskScore: 80,
            riskBand: "SEVERE",
            itcExposurePaise: clean!.itcExposure || 10_00_00,
            itcAtRiskPaise: clean!.itcExposure || 10_00_00,
            booksLineCount: 10,
            missingFrom2bCount: 8,
            hadRule37A: true,
            recordedAt: "2026-07-01T00:00:00.000Z",
          },
        ],
      },
    });

    const v = withHistory.vendors.find((x) => x.gstin === clean!.gstin)!;
    expect(v.trend).toBe("IMPROVING");
    expect(v.trendDeltaScore).toBeLessThan(0);
  });

  it("does not call a small month-to-month wobble a trend", () => {
    const someone = run.vendors[Math.floor(run.vendors.length / 2)];

    const withHistory = runReconciliation(dataset.purchases, dataset.gstr2b, {
      asOf: dataset.asOf,
      period: dataset.period,
      vendorHistory: {
        [someone.gstin]: [
          {
            gstin: someone.gstin,
            name: someone.name,
            period: "062026",
            // Three points off the actual score is noise, not a trend.
            riskScore: Math.max(0, Math.min(100, someone.riskScore + 3)),
            riskBand: someone.riskBand,
            itcExposurePaise: someone.itcExposure,
            itcAtRiskPaise: someone.itcAtRisk,
            booksLineCount: someone.booksLineCount,
            missingFrom2bCount: someone.missingFrom2bCount,
            hadRule37A: false,
            recordedAt: "2026-07-01T00:00:00.000Z",
          },
        ],
      },
    });

    const v = withHistory.vendors.find((x) => x.gstin === someone.gstin)!;
    expect(v.trend).toBe("STABLE");
  });

  it("counts an unbroken run of flagged periods, and resets the count at the first clean one", () => {
    const risky = run.vendors.find((v) => v.itcAtRisk > 0);
    expect(risky, "fixture assumption: expected a currently-flagged vendor").toBeDefined();

    const flaggedPeriod = (period: string, itcAtRiskPaise: number): VendorPeriodSnapshot => ({
      gstin: risky!.gstin,
      name: risky!.name,
      period,
      riskScore: 50,
      riskBand: "HIGH",
      itcExposurePaise: risky!.itcExposure || 10_00_00,
      itcAtRiskPaise,
      booksLineCount: 10,
      missingFrom2bCount: 3,
      hadRule37A: false,
      recordedAt: "2026-01-01T00:00:00.000Z",
    });

    const unbroken = runReconciliation(dataset.purchases, dataset.gstr2b, {
      asOf: dataset.asOf,
      period: dataset.period,
      vendorHistory: {
        [risky!.gstin]: ["042026", "052026", "062026"].map((p) => flaggedPeriod(p, 1_00_00)),
      },
    });
    expect(unbroken.vendors.find((x) => x.gstin === risky!.gstin)!.consecutiveFlaggedPeriods).toBe(4);

    const withGap = runReconciliation(dataset.purchases, dataset.gstr2b, {
      asOf: dataset.asOf,
      period: dataset.period,
      vendorHistory: {
        [risky!.gstin]: [
          flaggedPeriod("032026", 1_00_00),
          flaggedPeriod("042026", 0), // a clean month breaks the streak
          flaggedPeriod("052026", 1_00_00),
          flaggedPeriod("062026", 1_00_00),
        ],
      },
    });
    // Only the unbroken tail (May, Jun, plus this run) counts — March is cut
    // off by April's clean month sitting between it and now.
    expect(withGap.vendors.find((x) => x.gstin === risky!.gstin)!.consecutiveFlaggedPeriods).toBe(3);
  });
});

describe("history-aware loss probability", () => {
  const baseline = runReconciliation(dataset.purchases, dataset.gstr2b, {
    asOf: dataset.asOf,
    period: dataset.period,
  });

  /**
   * The entire point of tracking history: a vendor whose CURRENT month looks
   * clean can still be a bad bet if the last several months were not. This
   * run's data alone cannot see that — only the track record can.
   */
  it("raises the estimated loss for a vendor with a poor multi-month track record, even in an otherwise clean month", () => {
    const clean = baseline.decisions.find((d) => d.costOfPaying === 0 && d.exposure > 1_00_000);
    expect(clean, "fixture assumption: expected a decision with zero current loss cost and real exposure").toBeDefined();

    const withHistory = runReconciliation(dataset.purchases, dataset.gstr2b, {
      asOf: dataset.asOf,
      period: dataset.period,
      vendorHistory: {
        [clean!.supplierGstin]: ["042026", "052026", "062026"].map((period) => ({
          gstin: clean!.supplierGstin,
          name: clean!.supplierName,
          period,
          riskScore: 60,
          riskBand: "HIGH" as const,
          itcExposurePaise: 10_00_000,
          itcAtRiskPaise: 5_00_000,
          booksLineCount: 10,
          missingFrom2bCount: 5,
          hadRule37A: false,
          recordedAt: "2026-06-01T00:00:00.000Z",
        })),
      },
    });

    const decision = withHistory.decisions.find((d) => d.supplierGstin === clean!.supplierGstin);
    expect(decision).toBeDefined();
    expect(decision!.costOfPaying).toBeGreaterThan(clean!.costOfPaying);
    expect(decision!.rationale.join(" ")).toMatch(/averaged a \d+% miss rate/);
  });

  it("changes nothing when vendorHistory is omitted — this feature is additive, not a silent behaviour change", () => {
    const again = runReconciliation(dataset.purchases, dataset.gstr2b, {
      asOf: dataset.asOf,
      period: dataset.period,
    });
    expect(again.decisions.map((d) => d.costOfPaying)).toEqual(baseline.decisions.map((d) => d.costOfPaying));
    expect(again.decisions.map((d) => d.verdict)).toEqual(baseline.decisions.map((d) => d.verdict));
  });

  it("does not blend in a single prior period — one data point is not a rate", () => {
    const clean = baseline.decisions.find((d) => d.costOfPaying === 0 && d.exposure > 1_00_000);
    expect(clean).toBeDefined();

    const withOnePeriod = runReconciliation(dataset.purchases, dataset.gstr2b, {
      asOf: dataset.asOf,
      period: dataset.period,
      vendorHistory: {
        [clean!.supplierGstin]: [
          {
            gstin: clean!.supplierGstin,
            name: clean!.supplierName,
            period: "062026",
            riskScore: 60,
            riskBand: "HIGH",
            itcExposurePaise: 10_00_000,
            itcAtRiskPaise: 5_00_000,
            booksLineCount: 10,
            missingFrom2bCount: 5,
            hadRule37A: false,
            recordedAt: "2026-06-01T00:00:00.000Z",
          },
        ],
      },
    });

    const decision = withOnePeriod.decisions.find((d) => d.supplierGstin === clean!.supplierGstin);
    expect(decision!.costOfPaying).toBe(clean!.costOfPaying);
  });
});
