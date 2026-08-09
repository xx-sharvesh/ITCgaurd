/**
 * Cross-period vendor history.
 *
 * The risk score in `run.ts` is otherwise a single-month snapshot: upload a
 * new register and it forgets everything it knew about a vendor five minutes
 * earlier. This is what gives it memory, entirely inside the existing
 * localStorage MVP — no database, no account, no server.
 *
 * What is stored is a small digest (see `VendorPeriodSnapshot`), not the
 * register itself: a few hundred bytes per vendor per period rather than the
 * hundreds of kilobytes a purchase register runs to. Years of monthly runs
 * fit the browser's ~5 MB quota with room to spare, and the cap below makes
 * that true regardless of how long someone keeps using the product.
 *
 * Kept in its own key, separate from `session.ts`'s current-period data, on
 * purpose: history is the one thing in this product that should survive
 * "start a new reconciliation." Clearing the current session should not
 * erase the track record that makes next month's score sharper.
 */

import type { VendorPeriodSnapshot } from "../domain/types";

const KEY = "itcguard.vendor-history.v1";
const SCHEMA_VERSION = 1;

/**
 * Three years of monthly runs, per vendor. Far more than this product needs
 * to prove a track record, and it keeps storage bounded forever rather than
 * growing without limit for a customer still using this in 2030.
 */
const MAX_PERIODS_PER_VENDOR = 36;

interface HistoryFile {
  schemaVersion: number;
  snapshots: VendorPeriodSnapshot[];
}

function available(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const probe = "__itcguard_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return true;
  } catch {
    // Private browsing in some browsers throws on write rather than reporting
    // zero quota. Treat that as "no storage" instead of crashing the app.
    return false;
  }
}

/** All recorded snapshots, flat, oldest schema mismatches discarded rather than limped along. */
export function loadVendorHistory(): VendorPeriodSnapshot[] {
  if (!available()) return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as HistoryFile;
    if (parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.snapshots)) return [];
    return parsed.snapshots;
  } catch {
    return [];
  }
}

/** MMYYYY as a sortable YYYYMM integer. Malformed periods sort first rather than throwing. */
function periodSortKey(period: string): number {
  if (period.length !== 6) return 0;
  return Number(`${period.slice(2)}${period.slice(0, 2)}`);
}

/**
 * Group a flat snapshot list by vendor, each vendor's list ascending by
 * period. This is the shape the engine consumes: for a vendor being scored
 * this run, "history" means everything recorded strictly before now.
 */
export function groupHistoryByVendor(
  snapshots: VendorPeriodSnapshot[],
): Record<string, VendorPeriodSnapshot[]> {
  const byVendor: Record<string, VendorPeriodSnapshot[]> = {};
  for (const s of snapshots) {
    (byVendor[s.gstin] ??= []).push(s);
  }
  for (const list of Object.values(byVendor)) {
    list.sort((a, b) => periodSortKey(a.period) - periodSortKey(b.period));
  }
  return byVendor;
}

/**
 * Load history and drop the current period out of it, per vendor. What the
 * engine calls "history" for a run must never include that same run's own
 * period — otherwise a vendor's current score would be compared against
 * itself and every trend would read STABLE by construction.
 */
export function loadVendorHistoryExcluding(period: string): Record<string, VendorPeriodSnapshot[]> {
  const all = loadVendorHistory().filter((s) => s.period !== period);
  return groupHistoryByVendor(all);
}

export type RecordResult = { ok: true } | { ok: false; reason: string };

/**
 * Persist this run's vendor scores as history, replacing any existing entry
 * for the same vendor and period so re-reconciling a corrected file updates
 * history in place instead of duplicating it.
 *
 * Call this only for a real client upload — never for the sample dataset or
 * the public demo. Recording sample data here would silently mix a fictional
 * vendor's "track record" into a real company's history the next time they
 * reconcile, which is exactly the kind of quiet data corruption this product
 * exists to catch in other people's systems.
 */
export function recordVendorPeriod(newSnapshots: VendorPeriodSnapshot[]): RecordResult {
  if (newSnapshots.length === 0) return { ok: true };
  if (!available()) {
    return { ok: false, reason: "Local storage is unavailable, so vendor history was not saved." };
  }

  const existing = loadVendorHistory();
  const newKeys = new Set(newSnapshots.map((s) => `${s.gstin}:${s.period}`));
  const kept = existing.filter((s) => !newKeys.has(`${s.gstin}:${s.period}`));
  const merged = [...kept, ...newSnapshots];

  // Cap per vendor, not globally — a business with 200 vendors should not
  // have vendor #1's history evicted by vendor #200's.
  const byVendor = groupHistoryByVendor(merged);
  const capped: VendorPeriodSnapshot[] = [];
  for (const list of Object.values(byVendor)) {
    capped.push(...list.slice(-MAX_PERIODS_PER_VENDOR));
  }

  try {
    const payload: HistoryFile = { schemaVersion: SCHEMA_VERSION, snapshots: capped };
    window.localStorage.setItem(KEY, JSON.stringify(payload));
    return { ok: true };
  } catch (err) {
    const quotaExceeded =
      err instanceof DOMException &&
      (err.name === "QuotaExceededError" || err.name === "NS_ERROR_DOM_QUOTA_REACHED");
    return {
      ok: false,
      reason: quotaExceeded
        ? "Vendor history is full for this browser. This run is unaffected; only the trend for future runs will be thinner."
        : "Could not save vendor history locally.",
    };
  }
}

export function clearVendorHistory(): void {
  if (!available()) return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Best-effort: clearing is not load-bearing the way saving is.
  }
}
