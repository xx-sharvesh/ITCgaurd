"use client";

import { useCallback, useEffect, useState } from "react";
import { clearSession, loadSession, saveSession } from "@/lib/store/session";
import { clearVendorHistory } from "@/lib/store/vendor-history";
import { Dashboard, type DashboardData } from "@/components/Dashboard";
import { Onboarding } from "@/components/Onboarding";

export default function Page() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [saveWarning, setSaveWarning] = useState<string | null>(null);
  // Whether the current data is the built-in fixture rather than a real
  // upload. Vendor history must never be written for sample data — a demo
  // run's fictional vendors have no business polluting a real company's
  // track record the next time they reconcile an actual register.
  const [isSample, setIsSample] = useState(false);

  /**
   * Restore any saved session after mount.
   *
   * `data` starts null so the server and the first client render agree on the
   * onboarding screen — reading localStorage during render would desynchronise
   * them. Deliberately NOT gated behind a "hydrated" flag that blanks the page
   * until JS boots: the onboarding screen is the product's shop window, and
   * server-rendering it means a visitor sees the pitch immediately rather than
   * a spinner. A returning user briefly sees onboarding before their session
   * swaps in, which is the right trade — first-time visitors are the ones we
   * cannot afford to make wait.
   */
  useEffect(() => {
    const stored = loadSession();
    if (!stored) return;
    setIsSample(stored.isSample);
    setData({
      purchases: stored.purchases,
      gstr2b: stored.gstr2b,
      asOf: stored.asOf,
      period: stored.period,
      company: stored.company,
      sources: stored.sources,
    });
  }, []);

  const handleLoad = useCallback((loaded: DashboardData, opts?: { isSample?: boolean }) => {
    const sample = opts?.isSample ?? false;
    setData(loaded);
    setIsSample(sample);
    const result = saveSession({
      company: loaded.company,
      asOf: loaded.asOf,
      period: loaded.period,
      purchases: loaded.purchases,
      gstr2b: loaded.gstr2b,
      sources: loaded.sources,
      resolved: [],
      isSample: sample,
    });
    setSaveWarning(result.ok ? null : result.reason);
  }, []);

  const handleReset = useCallback(() => {
    clearSession();
    setData(null);
    setIsSample(false);
    setSaveWarning(null);
  }, []);

  if (!data) return <Onboarding onLoad={handleLoad} />;

  return (
    <Dashboard
      data={data}
      saveWarning={saveWarning}
      onReset={handleReset}
      onClearHistory={clearVendorHistory}
      historyEnabled={!isSample}
    />
  );
}
