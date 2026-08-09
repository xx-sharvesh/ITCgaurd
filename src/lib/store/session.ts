/**
 * Local persistence.
 *
 * Deliberately localStorage and nothing else for now. Two reasons, one
 * technical and one commercial:
 *
 *   - The whole engine is pure and runs in a few hundred milliseconds, so
 *     there is nothing worth caching. We store the INPUTS and recompute the
 *     run on load. That keeps the payload small and means an engine fix
 *     applies retroactively to saved sessions instead of leaving a stale
 *     result frozen in storage.
 *
 *   - "Your ledger never leaves your machine" is the single strongest answer
 *     to the security objection in a free-audit funnel, and it is only true
 *     while the data stays here. When a real database arrives it must be an
 *     explicit, opt-in upload, not a silent default.
 *
 * Storage is capped by the browser at roughly 5 MB. A 600-line register plus
 * its 2B is around 300 KB of JSON, so a year of monthly sessions fits
 * comfortably; we still guard the quota and fail loudly rather than silently
 * dropping a save.
 */

import type { GSTR2BRecord, PurchaseRecord } from "../domain/types";

const KEY = "itcguard.session.v1";
const SCHEMA_VERSION = 1;

export interface CompanyProfile {
  name: string;
  gstin: string;
  /** Effective corporate tax rate, for pricing a Sec 43B(h) disallowance. */
  effectiveTaxRate: number;
  /** Whether written agreements exist with MSME suppliers (45 vs 15 days). */
  msmeWrittenAgreement: boolean;
}

export interface StoredSession {
  schemaVersion: number;
  savedAt: string;
  company: CompanyProfile;
  /** Reference date for every statutory clock in the run. */
  asOf: string;
  period: string;
  purchases: PurchaseRecord[];
  gstr2b: GSTR2BRecord[];
  /** Where the data came from, shown in the report provenance line. */
  sources: {
    register?: string;
    portal?: string;
  };
  /** Actions the user has taken, so the cockpit remembers what is done. */
  resolved: string[];
  /**
   * True for the built-in fixture, false for a real upload. Persisted so the
   * distinction survives a reload — vendor history must never be written for
   * a restored sample session, and this is the only record of which one this
   * was after the original upload/demo choice has scrolled out of memory.
   */
  isSample: boolean;
}

export const DEFAULT_COMPANY: CompanyProfile = {
  name: "Vasudha Engineering Industries Pvt Ltd",
  gstin: "27AABCV7182N1ZO",
  effectiveTaxRate: 0.26,
  msmeWrittenAgreement: true,
};

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

export function loadSession(): StoredSession | null {
  if (!available()) return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;

    // A schema bump means the shape we saved is not the shape we now read.
    // Discard rather than limp along with half-migrated data — the cost of
    // re-uploading is seconds, the cost of a wrong number is the customer.
    if (parsed.schemaVersion !== SCHEMA_VERSION) return null;
    if (!Array.isArray(parsed.purchases) || !Array.isArray(parsed.gstr2b)) return null;

    // isSample was added after the first release of this schema. A session
    // saved before it existed genuinely was a real upload (the sample flow
    // did not carry a distinct flag yet), so defaulting the missing field to
    // false is the correct historical answer, not a guess.
    return { ...parsed, isSample: Boolean(parsed.isSample) };
  } catch {
    return null;
  }
}

export type SaveResult = { ok: true } | { ok: false; reason: string };

export function saveSession(session: Omit<StoredSession, "schemaVersion" | "savedAt">): SaveResult {
  if (!available()) {
    return { ok: false, reason: "This browser is blocking local storage, so the session cannot be saved." };
  }

  const payload: StoredSession = {
    ...session,
    schemaVersion: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
  };

  try {
    window.localStorage.setItem(KEY, JSON.stringify(payload));
    return { ok: true };
  } catch (err) {
    const quotaExceeded =
      err instanceof DOMException &&
      (err.name === "QuotaExceededError" || err.name === "NS_ERROR_DOM_QUOTA_REACHED");

    return {
      ok: false,
      reason: quotaExceeded
        ? "This register is too large for browser storage. The reconciliation still works — it just will not persist across a reload."
        : "Could not save the session locally.",
    };
  }
}

export function clearSession(): void {
  if (!available()) return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing useful to do; clearing is best-effort.
  }
}

/** Approximate size of the stored session, for the settings screen. */
export function sessionSizeBytes(): number {
  if (!available()) return 0;
  try {
    return window.localStorage.getItem(KEY)?.length ?? 0;
  } catch {
    return 0;
  }
}
