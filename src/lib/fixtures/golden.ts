/**
 * Golden invoice-number pairs — the ground truth for the matcher's
 * normalisation tier.
 *
 * Every pair here is hand-written from the shapes Indian suppliers actually
 * print: financial years embedded three different ways, zero padding that comes
 * and goes, month codes, ERP exports that run everything together, and the
 * Excel autocorrect that turns a hyphen into an en dash.
 *
 * The negatives matter more than the positives. ITC Guard's promise is zero
 * false positives — telling a CFO two documents are the same when they are not
 * is worse than telling them nothing, because they will act on it. So the
 * `same: false` half is stocked with pairs that a naive normaliser or a bare
 * edit-distance check will happily merge: "INV/91" vs "INV/191",
 * "2026/001" vs "2026/010", transposed serials, and the same serial under two
 * financial years.
 *
 * Contract for whoever implements the matcher, expressed as what `selfcheck.ts`
 * asserts against `domain/normalize.ts`:
 *   - every `same: true` pair collapses at one of the tiers (strict key, loose
 *     key, FY-stripped key, or bounded Levenshtein <= 2 on either key);
 *   - no `same: false` pair collapses at the strict or loose key.
 * Note the asymmetry: the FY-stripped tier and the Levenshtein tier are NOT
 * safe on their own — pair 47 and pair 30 collide there deliberately. Those
 * tiers must never fire without amount corroboration.
 */

export interface GoldenPair {
  a: string;
  b: string;
  same: boolean;
  why: string;
}

export const GOLDEN_PAIRS: readonly GoldenPair[] = [
  // -------------------------------------------------------------------------
  // Same document — separator, padding, case and spacing drift
  // -------------------------------------------------------------------------
  {
    a: "INV/2026-27/0091",
    b: "INV-2026-27-91",
    same: true,
    why: "Separators swapped and the serial de-padded. The canonical books-vs-2B drift.",
  },
  {
    a: "INV/2026-27/0091",
    b: "inv/2026-27/0091",
    same: true,
    why: "Case only. GSTR-1 upper-cases what the supplier typed in mixed case.",
  },
  {
    a: "INV 2026-27 0091",
    b: "INV/2026-27/0091",
    same: true,
    why: "Spaces where the other side has slashes.",
  },
  {
    a: "GST/JUL/0451",
    b: "GST-JUL-451",
    same: true,
    why: "Month-coded series; separators and padding differ, month code identical.",
  },
  {
    a: "TI-0087",
    b: "TI0087",
    same: true,
    why: "The hyphen is presentational.",
  },
  {
    a: "TI-0087",
    b: "TI-87",
    same: true,
    why: "Leading zeros dropped by the clerk keying the purchase register.",
  },
  {
    a: "0142",
    b: "142",
    same: true,
    why: "Bare serial from a proprietorship; zero padding is not part of the identity.",
  },
  {
    a: "SBT/26-27/0142",
    b: "SBT-26-27-142",
    same: true,
    why: "Two-digit FY form, separators and padding drift.",
  },
  {
    a: "KLPL26270034",
    b: "KLPL/2627/0034",
    same: true,
    why: "ERP export ran the fields together; the portal shows the printed form.",
  },
  {
    a: "INV#0091",
    b: "INV-0091",
    same: true,
    why: "'#' as a separator — common on hand-designed invoice stationery.",
  },
  {
    a: "  INV/0091  ",
    b: "INV/0091",
    same: true,
    why: "Leading/trailing whitespace from a spreadsheet cell.",
  },
  {
    a: "MH/INV/000123",
    b: "MH-INV-123",
    same: true,
    why: "Three-part number, six-digit padding on one side only.",
  },
  {
    a: "2026-27/0087",
    b: "202627 87",
    same: true,
    why: "No alpha prefix at all; FY and serial run together on the portal side.",
  },
  {
    a: "CN/2026-27/012",
    b: "CN-2026-27-12",
    same: true,
    why: "Credit-note series, same drift as invoices.",
  },
  {
    a: "DFC/JUL/0451",
    b: "DFC/Jul/0451",
    same: true,
    why: "Month code capitalised differently.",
  },
  {
    a: "SPC-1201",
    b: "SPC 1201",
    same: true,
    why: "Hyphen versus space.",
  },
  {
    a: "VE/0007",
    b: "VE/7",
    same: true,
    why: "Four-digit padding stripped to a single digit.",
  },
  {
    a: "HRW-0304",
    b: "hrw0304",
    same: true,
    why: "Lower-cased and unseparated.",
  },
  {
    a: "BCS-26-27-0455",
    b: "BCS/26/27/0455",
    same: true,
    why: "Hyphens versus slashes throughout.",
  },
  {
    a: "RFA/2026-27/1180",
    b: "RFA/2026-27/1180 ",
    same: true,
    why: "Trailing space only — the most common diff in an uploaded CSV.",
  },
  {
    a: "ACI-0912",
    b: "ACI–0912",
    same: true,
    why: "Excel autocorrected the hyphen into an en dash on one side.",
  },
  {
    a: "NIS26270118",
    b: "NIS-2627-0118",
    same: true,
    why: "Same digits, one side unseparated.",
  },
  {
    a: "VPS26270006",
    b: "VPS-2627-0006",
    same: true,
    why: "Compact ERP form versus the printed form.",
  },
  {
    a: "PPT-26-27-0009",
    b: "PPT/26-27/9",
    same: true,
    why: "Single-digit serial padded to four on the books side.",
  },
  {
    a: "YPI/2026-27/0505",
    b: "YPI 2026-27 505",
    same: true,
    why: "Spaces plus de-padding.",
  },
  {
    a: "CFS/2026-27/0777",
    b: "cfs-2026-27-777",
    same: true,
    why: "Case, separators and padding all differ at once.",
  },
  {
    a: "MTC/JUN/1042",
    b: "MTC/JUN/01042",
    same: true,
    why: "Extra pad digit added by the portal upload template.",
  },
  {
    a: "BJF/26-27/0206",
    b: "BJF26270206",
    same: true,
    why: "Separators removed entirely.",
  },
  {
    a: "DDP-26-27-0233",
    b: "DDP/26-27/0233",
    same: true,
    why: "Separator style only.",
  },
  {
    a: "KLE-0088",
    b: "KLE-O088",
    same: true,
    why: "Capital O keyed for a zero. Recoverable only by edit distance, which is exactly why the edit-distance tier must also demand an amount match — see the 'INV/91' vs 'INV/191' negative.",
  },
  {
    a: "HMT-26-27-0777",
    b: "HMT 26 27 777",
    same: true,
    why: "Spaces and de-padding on a two-digit FY series.",
  },
  {
    a: "SCS/2026-27/0061",
    b: "SCS/2026-27/61",
    same: true,
    why: "Padding only.",
  },
  {
    a: "MRP/2026-27/0128",
    b: "MRP2026270128",
    same: true,
    why: "Unseparated ERP export.",
  },
  {
    a: "CP-26-27-0019",
    b: "CP-26-27-19",
    same: true,
    why: "Padding only, short alpha prefix.",
  },
  {
    a: "NTC26270412",
    b: "NTC 2627 0412",
    same: true,
    why: "Spaces reinserted by a human retyping the number.",
  },
  {
    a: "GLH/AUG/0056",
    b: "GLH/AUG/56",
    same: true,
    why: "Padding only, month-coded series.",
  },
  {
    a: "GFM/SEP/0180",
    b: "GFM-SEP-0180",
    same: true,
    why: "Separator style only.",
  },
  {
    a: "1042",
    b: "01042",
    same: true,
    why: "Bare serials differing only in a leading zero.",
  },
  {
    a: "AB/123",
    b: "AB/0123",
    same: true,
    why: "Two-letter prefix, padding drift.",
  },
  {
    a: "PO-4471/INV-0088",
    b: "PO4471INV88",
    same: true,
    why: "Buyer PO number embedded in the invoice number; both parts survive normalisation.",
  },
  {
    a: "SBT/26-27/0142",
    b: "SBT/26-27/00142",
    same: true,
    why: "Five-digit padding on one side.",
  },
  {
    a: "27AKPPB/0091",
    b: "27AKPPB-91",
    same: true,
    why: "Supplier prefixes its own GSTIN fragment; only the serial padding drifts.",
  },
  {
    a: "EXP/2026-27/0004",
    b: "EXP/2026-27/004",
    same: true,
    why: "Three- versus four-digit padding.",
  },

  // -------------------------------------------------------------------------
  // Same document — only the FY-stripped tier reaches it
  // -------------------------------------------------------------------------
  {
    a: "INV/2026-27/0091",
    b: "INV/0091",
    same: true,
    why: "2B carries the year the supplier prints, books dropped it. Reachable only after stripping the FY, so this tier must be corroborated by amount and GSTIN.",
  },
  {
    a: "GSR/2026-27/0044",
    b: "GSR/44",
    same: true,
    why: "FY dropped and serial de-padded together. FY-stripped tier, amount corroboration required.",
  },
  {
    a: "VIL/2026-27/0009",
    b: "VIL/9",
    same: true,
    why: "Same as above with a single-digit serial — the loosest legitimate case in this file.",
  },

  // -------------------------------------------------------------------------
  // DIFFERENT documents — the false-positive traps
  // -------------------------------------------------------------------------
  {
    a: "INV/91",
    b: "INV/191",
    same: false,
    why: "Edit distance 1, but 91 and 191 are two invoices. The single most common way a fuzzy matcher invents a match.",
  },
  {
    a: "2026/001",
    b: "2026/010",
    same: false,
    why: "Serial 1 versus serial 10. Identical after a careless 'strip all zeros' normalisation; they are different documents.",
  },
  {
    a: "INV/2026-27/0091",
    b: "INV/2025-26/0091",
    same: false,
    why: "Same serial, different financial year. Collides once the FY is stripped, which is precisely why the FY-stripped tier is not allowed to stand alone.",
  },
  {
    a: "SPC-1201",
    b: "SPC-1210",
    same: false,
    why: "Transposed last two digits — edit distance 2, two real invoices.",
  },
  {
    a: "0142",
    b: "1420",
    same: false,
    why: "A trailing zero is not padding. Different serials.",
  },
  {
    a: "GST/JUL/0450",
    b: "GST/JUL/4500",
    same: false,
    why: "Same digits in the same order, different magnitude of serial.",
  },
  {
    a: "TI-0087",
    b: "TI-0087A",
    same: false,
    why: "The 'A' suffix is a revised/amended document with its own value; merging them double-counts or hides a revision.",
  },
  {
    a: "INV/2026-27/0091",
    b: "INV/2026-27/0092",
    same: false,
    why: "Consecutive serials from the same supplier, often issued the same day for similar amounts.",
  },
  {
    a: "CN/2026-27/012",
    b: "DN/2026-27/012",
    same: false,
    why: "Credit note versus debit note on the same serial. They move ITC in opposite directions — matching them is a sign error worth twice the tax.",
  },
  {
    a: "MH/INV/000123",
    b: "MH/INV/000132",
    same: false,
    why: "Transposed digits inside a padded serial.",
  },
  {
    a: "KLPL/2627/0034",
    b: "KLPL/2728/0034",
    same: false,
    why: "Same serial in the following financial year — the vendor restarts its counter each April.",
  },
  {
    a: "VE/0007",
    b: "VE/0070",
    same: false,
    why: "7 and 70, not a padding difference.",
  },
  {
    a: "SBT/26-27/0142",
    b: "SBT/26-27/1420",
    same: false,
    why: "Serial 142 versus 1420.",
  },
  {
    a: "BCS-26-27-0455",
    b: "BCS-26-27-4550",
    same: false,
    why: "Serial 455 versus 4550.",
  },
  {
    a: "1042",
    b: "10420",
    same: false,
    why: "Bare serials; the trailing zero is significant.",
  },
  {
    a: "AB/123",
    b: "AB/1230",
    same: false,
    why: "Trailing digit added, not a pad.",
  },
  {
    a: "HRW-0304",
    b: "HRW-3040",
    same: false,
    why: "304 and 3040 from a vendor that issues thousands of warehousing invoices a year.",
  },
  {
    a: "RFA/2026-27/1180",
    b: "RFA/2026-27/1108",
    same: false,
    why: "Transposition inside a four-digit serial; both exist in the same month.",
  },
  {
    a: "ACI-0912",
    b: "ACI-0921",
    same: false,
    why: "Transposition, edit distance 2.",
  },
  {
    a: "DFC/JUL/0451",
    b: "DFC/JUN/0451",
    same: false,
    why: "Transporters restart the serial each month; the month code is load-bearing, not decoration.",
  },
  {
    a: "GSR/2026-27/0044",
    b: "GSR/2026-27/0440",
    same: false,
    why: "44 versus 440.",
  },
  {
    a: "SCS/2026-27/0061",
    b: "SCS/2026-27/0610",
    same: false,
    why: "61 versus 610.",
  },
  {
    a: "PPT-26-27-0009",
    b: "PPT-26-27-0090",
    same: false,
    why: "9 versus 90 — both plausible early-year serials.",
  },
  {
    a: "KAS-0501",
    b: "KAS-5010",
    same: false,
    why: "501 versus 5010.",
  },
  {
    a: "NTC26270412",
    b: "NTC26270421",
    same: false,
    why: "Transposition inside an unseparated ERP number, where there is no punctuation to anchor on.",
  },
  {
    a: "MTC/JUN/1042",
    b: "MTC/JUL/1042",
    same: false,
    why: "Same serial, consecutive months.",
  },
  {
    a: "CCPL/2026-27/0007",
    b: "CCPL/2026-27/0070",
    same: false,
    why: "7 versus 70.",
  },
  {
    a: "SLB-0031",
    b: "SLB-0310",
    same: false,
    why: "31 versus 310.",
  },
  {
    a: "BJF/26-27/0206",
    b: "BJF/26-27/0260",
    same: false,
    why: "206 versus 260 — transposition that survives de-padding.",
  },
  {
    a: "GEW-0450",
    b: "GEW-0455",
    same: false,
    why: "Adjacent serials, edit distance 1. Only the amount tells them apart.",
  },
];

export const GOLDEN_SAME_COUNT = GOLDEN_PAIRS.filter((p) => p.same).length;
export const GOLDEN_DIFFERENT_COUNT = GOLDEN_PAIRS.length - GOLDEN_SAME_COUNT;
