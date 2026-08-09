/**
 * Proves the vendor-history loop end to end: run a period, snapshot it,
 * feed that snapshot back in as prior history for a second run, and check
 * that trend/streak/blended-probability come out sane on real fixture data
 * rather than only on hand-built unit-test snapshots.
 */

import { generateDataset } from "../src/lib/fixtures/generate";
import { runReconciliation, snapshotVendors } from "../src/lib/engine/run";
import { groupHistoryByVendor } from "../src/lib/store/vendor-history";
import { formatINRCompact } from "../src/lib/domain/money";

const dataset = generateDataset({ seed: 20260809, lines: 600 });

const july = runReconciliation(dataset.purchases, dataset.gstr2b, {
  asOf: dataset.asOf,
  period: "072026",
});

const julySnapshots = snapshotVendors(july);
console.log(`July run: ${july.vendors.length} vendors scored, ${julySnapshots.length} snapshots taken`);
console.log(`Every vendor trend on a first-ever run: ${[...new Set(july.vendors.map((v) => v.trend))].join(", ")}`);

// Pretend a month has passed with no change in the underlying data, feed
// July's own scores back in as "prior history", and re-run as if it were
// August. A vendor whose behaviour is identical should read STABLE, not
// WORSENING or IMPROVING from noise.
const historyForAugust = groupHistoryByVendor(julySnapshots);
const august = runReconciliation(dataset.purchases, dataset.gstr2b, {
  asOf: dataset.asOf,
  period: "082026",
  vendorHistory: historyForAugust,
});

const trendCounts = august.vendors.reduce<Record<string, number>>((acc, v) => {
  acc[v.trend] = (acc[v.trend] ?? 0) + 1;
  return acc;
}, {});
console.log(`\nAugust (identical data, July fed in as history) trend distribution: ${JSON.stringify(trendCounts)}`);

const unstable = august.vendors.filter((v) => v.trend !== "STABLE");
if (unstable.length > 0) {
  console.log(`UNEXPECTED: ${unstable.length} vendor(s) did not read STABLE on identical data:`);
  for (const v of unstable.slice(0, 5)) {
    console.log(`  ${v.name}: ${v.trend} (delta ${v.trendDeltaScore})`);
  }
} else {
  console.log("OK: every vendor reads STABLE when nothing has actually changed.");
}

// Chain three more identical months to prove the mechanics accumulate
// correctly across real, sequential runReconciliation calls rather than only
// in a hand-built unit-test snapshot. This vendor's underlying data never
// changes here, so the score stays flat by design — what this demonstrates
// is that the streak keeps counting (2, 3, 4) and the loss-probability basis
// text picks up the "averaged over N months" clause once two periods of
// history exist, on the actual fixture rather than synthetic test data.
const worst = [...august.vendors].sort((a, b) => b.itcAtRisk - a.itcAtRisk)[0];
console.log(`\nChaining ${worst.name} (${worst.gstin}) across four more identical months...`);

let history = historyForAugust;
let label = "August";
for (const period of ["092026", "102026", "112026"]) {
  const run = runReconciliation(dataset.purchases, dataset.gstr2b, {
    asOf: dataset.asOf,
    period,
    vendorHistory: history,
  });
  const v = run.vendors.find((x) => x.gstin === worst.gstin)!;
  console.log(
    `  ${label} -> ${period}: score ${v.riskScore} (${v.trend}${v.trendDeltaScore !== null ? " " + v.trendDeltaScore : ""}), ` +
      `streak ${v.consecutiveFlaggedPeriods}, historicalMissRate ${v.historicalMissRate === null ? "n/a" : (v.historicalMissRate * 100).toFixed(0) + "%"}`,
  );
  const decision = run.decisions.find((d) => d.supplierGstin === worst.gstin);
  if (decision) {
    console.log(
      `    pay/hold: ${decision.verdict}, cost of paying ${formatINRCompact(decision.costOfPaying)}, ` +
        `basis: ${decision.rationale[0]}`,
    );
  }
  history = groupHistoryByVendor([
    ...Object.values(history).flat(),
    ...snapshotVendors(run),
  ]);
  label = period;
}
