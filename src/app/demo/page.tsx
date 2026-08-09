import type { Metadata } from "next";
import Link from "next/link";
import { generateDataset } from "@/lib/fixtures/generate";
import { DEFAULT_COMPANY } from "@/lib/store/session";
import { Dashboard } from "@/components/Dashboard";

export const metadata: Metadata = {
  title: "ITC Guard — live demo on a sample register",
  description:
    "A worked reconciliation for a mid-size Maharashtra manufacturer: 616 purchase lines against GSTR-2B, with the input tax credit at risk priced by statutory provision.",
};

/**
 * The public demo.
 *
 * Server-rendered from the deterministic fixture, so a prospect can be sent a
 * link and see the whole product working on realistic data without uploading
 * anything. It renders the same `Dashboard` as a live session — a demo that
 * diverges from the real product is worse than no demo.
 *
 * Static: the fixture is deterministic, so this prerenders at build time and
 * costs nothing to serve.
 */
export default function DemoPage() {
  const dataset = generateDataset({ seed: 20260809, lines: 600 });

  return (
    <Dashboard
      data={{
        purchases: dataset.purchases,
        gstr2b: dataset.gstr2b,
        asOf: dataset.asOf,
        period: dataset.period,
        company: DEFAULT_COMPANY,
        sources: { register: "Sample register (616 lines)", portal: "Sample GSTR-2B" },
      }}
      demoBanner={
        <div className="no-print mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--color-gold-line)] bg-[var(--color-gold-soft)] px-4 py-3">
          <p className="text-[12.5px] leading-relaxed text-[var(--color-ink-soft)]">
            <strong className="font-semibold text-[var(--color-ink)]">Sample data.</strong> A
            generated register for a fictional manufacturer, with every defect class deliberately
            seeded. Nothing here is real trading data.
          </p>
          <Link
            href="/"
            className="shrink-0 text-[12.5px] font-semibold text-[var(--color-ink)] underline-offset-2 hover:underline"
          >
            Run it on your own files →
          </Link>
        </div>
      }
    />
  );
}
