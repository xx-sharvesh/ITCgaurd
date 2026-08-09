/**
 * Prints a real reconciliation run to the console.
 *
 * Kept in the repo because "the tests pass" and "the numbers look sane to a
 * human" are different claims, and a money product needs both. Run with:
 *   node --experimental-strip-types scripts/smoke.ts
 */

import { generateDataset, defectCensus } from "../src/lib/fixtures/generate";
import { runReconciliation, unclaimedOpportunity } from "../src/lib/engine/run";
import { formatINR, formatINRCompact } from "../src/lib/domain/money";

const dataset = generateDataset({ seed: 20260809, lines: 600 });
const run = runReconciliation(dataset.purchases, dataset.gstr2b, {
  asOf: dataset.asOf,
  period: dataset.period,
});

const rule = (label: string) => `\n${label}\n${"â”€".repeat(74)}`;

console.log(rule("INPUT"));
console.log(`Purchase register   ${dataset.purchases.length} lines`);
console.log(`GSTR-2B             ${dataset.gstr2b.length} lines`);
console.log(`Vendors             ${run.vendors.length}`);
console.log(`As of               ${dataset.asOf}   Period ${dataset.period}`);

console.log(rule("HEADLINE"));
console.log(`ITC AT RISK         ${formatINRCompact(run.totalAtRisk)}   (${formatINR(run.totalAtRisk)})`);
console.log(`Unclaimed credit    ${formatINRCompact(unclaimedOpportunity(run.findings))}`);
console.log(`Auto-resolved       ${(run.autoResolvedRatio * 100).toFixed(1)}%`);

const tiers = run.matches.reduce<Record<string, number>>((acc, m) => {
  acc[m.tier] = (acc[m.tier] ?? 0) + 1;
  return acc;
}, {});
console.log(rule("MATCH TIERS"));
for (const [tier, count] of Object.entries(tiers).sort((a, b) => b[1] - a[1])) {
  const pct = ((count / run.matches.length) * 100).toFixed(1).padStart(5);
  console.log(`${tier.padEnd(16)} ${String(count).padStart(5)}  ${pct}%`);
}

const byRule = new Map<string, { count: number; amount: number }>();
for (const f of run.findings) {
  const cur = byRule.get(f.rule) ?? { count: 0, amount: 0 };
  cur.count += 1;
  cur.amount += f.amountAtRisk;
  byRule.set(f.rule, cur);
}
console.log(rule("EXPOSURE BY RULE"));
for (const [ruleId, { count, amount }] of [...byRule].sort((a, b) => b[1].amount - a[1].amount)) {
  console.log(`${ruleId.padEnd(32)} ${String(count).padStart(4)}  ${formatINRCompact(amount).padStart(12)}`);
}

console.log(rule("WORST VENDORS"));
for (const v of run.vendors.slice(0, 8)) {
  console.log(
    `${v.name.slice(0, 34).padEnd(35)} ${v.riskBand.padEnd(7)} score ${String(v.riskScore).padStart(3)}  at risk ${formatINRCompact(v.itcAtRisk).padStart(11)}`,
  );
}

console.log(rule("PAY / HOLD"));
const verdicts = run.decisions.reduce<Record<string, number>>((acc, d) => {
  acc[d.verdict] = (acc[d.verdict] ?? 0) + 1;
  return acc;
}, {});
console.log(Object.entries(verdicts).map(([v, c]) => `${v}=${c}`).join("   "));
for (const d of run.decisions.slice(0, 4)) {
  console.log(`\n  ${d.supplierName}  â†’  ${d.verdict}`);
  console.log(`  exposure ${formatINRCompact(d.exposure)} | pay costs ${formatINRCompact(d.costOfPaying)} | hold costs ${formatINRCompact(d.costOfHolding)}`);
  console.log(`  ${d.rationale[0]}`);
}

console.log(rule("CONTROL TOTALS"));
const t = run.totals;
console.log(`Books ITC           ${formatINR(t.booksItc).padStart(18)}`);
console.log(`  matched           ${formatINR(t.matchedItc).padStart(18)}`);
console.log(`  unmatched         ${formatINR(t.booksOnlyItc).padStart(18)}`);
console.log(`GSTR-2B ITC         ${formatINR(t.gstr2bItc).padStart(18)}`);
console.log(`  not in books      ${formatINR(t.gstr2bOnlyItc).padStart(18)}`);
console.log(`BALANCED            ${t.balanced ? "YES" : "NO â€” " + t.imbalanceNote}`);

console.log(rule("FIXTURE DEFECT CENSUS"));
console.log(
  Object.entries(defectCensus(dataset))
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join("  "),
);
console.log();

