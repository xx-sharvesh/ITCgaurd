/**
 * Vendor master fixtures — 40 suppliers to a Pune-based mid-market manufacturer.
 *
 * The mix is deliberate, not decorative. A real Indian purchase register is not
 * 40 identical Pvt Ltds: it is a long tail of proprietorships and HUF "& Sons"
 * firms (which is where the MSME 45-day exposure lives), a middle of LLPs and
 * small private limiteds, and a handful of large non-MSME vendors that carry
 * most of the value. The pay/hold engine only produces interesting answers when
 * the vendor population has that shape.
 *
 * `filingBehaviour` is the fixture's editorial judgement about a vendor, used by
 * `generate.ts` to decide who fails to file, who files late, and who is safe. It
 * is not a field the product computes — the product derives a risk band from
 * observed data. Keeping the two separate is what lets a test assert that the
 * engine independently rediscovers the behaviour we planted.
 */

import type { MsmeStatus } from "../domain/types";
import { isValidGstin, STATE_NAMES } from "../domain/gstin";
import { FIXTURE_GSTINS } from "./gstins";

/**
 * How reliably the supplier files GSTR-1/3B.
 *  PUNCTUAL  — files on time, every period.
 *  LATE      — files, but after the recipient's 2B for that period is generated.
 *  ERRATIC   — misses periods, files partial data, occasional 3B gap.
 *  DEFAULTER — GSTR-1 patchy or absent; the vendor you chase every month.
 */
export type FilingBehaviour = "PUNCTUAL" | "LATE" | "ERRATIC" | "DEFAULTER";

export type VendorSector = "manufacturing" | "logistics" | "services" | "trading";

/**
 * The house style each vendor uses to number its invoices. Suppliers are
 * remarkably consistent within themselves and wildly inconsistent with each
 * other, which is precisely why invoice-number matching is hard.
 */
export type NumberingStyle =
  /** `INV/2026-27/0091` — prefix, full financial year, zero-padded serial. */
  | "SLASH_FY"
  /** `PPT-26-27-0091` — same idea, hyphens and a two-digit FY. */
  | "DASH_FY"
  /** `SPC-0091` — prefix and serial, no year at all. */
  | "PREFIX_SEQ"
  /** `0091` — bare serial, common with small proprietorships. */
  | "PLAIN_SEQ"
  /** `DFC/JUL/0091` — prefix, month, serial. Typical of transporters. */
  | "SLASH_MONTH"
  /** `VPS26270091` — everything run together by an ERP export. */
  | "COMPACT_FY";

export interface VendorFixture {
  /** Stable fixture id. Also the key into `FIXTURE_GSTINS`. */
  id: string;
  name: string;
  gstin: string;
  msmeStatus: MsmeStatus;
  /** Two-digit GST state code; must agree with the first two GSTIN characters. */
  state: string;
  stateName: string;
  sector: VendorSector;
  filingBehaviour: FilingBehaviour;
  numberingStyle: NumberingStyle;
  /** Alphabetic prefix in this vendor's invoice numbers; empty for PLAIN_SEQ. */
  invoicePrefix: string;
}

export const VENDORS: readonly VendorFixture[] = [
  // --- Maharashtra (27): intra-state, so CGST + SGST -------------------------
  {
    id: "V01",
    name: "Shree Balaji Steel Traders",
    gstin: FIXTURE_GSTINS.V01,
    msmeStatus: "MICRO",
    state: "27",
    stateName: "Maharashtra",
    sector: "trading",
    filingBehaviour: "PUNCTUAL",
    numberingStyle: "SLASH_FY",
    invoicePrefix: "SBT",
  },
  {
    id: "V02",
    name: "Nirmal Packaging Industries",
    gstin: FIXTURE_GSTINS.V02,
    msmeStatus: "SMALL",
    state: "27",
    stateName: "Maharashtra",
    sector: "manufacturing",
    filingBehaviour: "PUNCTUAL",
    numberingStyle: "SLASH_FY",
    invoicePrefix: "INV",
  },
  {
    id: "V03",
    name: "Godavari Engineering Works",
    gstin: FIXTURE_GSTINS.V03,
    msmeStatus: "MICRO",
    state: "27",
    stateName: "Maharashtra",
    sector: "manufacturing",
    filingBehaviour: "LATE",
    numberingStyle: "PREFIX_SEQ",
    invoicePrefix: "GEW",
  },
  {
    id: "V04",
    name: "Deccan Freight Carriers Pvt Ltd",
    gstin: FIXTURE_GSTINS.V04,
    msmeStatus: "MEDIUM",
    state: "27",
    stateName: "Maharashtra",
    sector: "logistics",
    filingBehaviour: "PUNCTUAL",
    numberingStyle: "SLASH_MONTH",
    invoicePrefix: "DFC",
  },
  {
    id: "V05",
    name: "Pune Precision Tools Pvt Ltd",
    gstin: FIXTURE_GSTINS.V05,
    msmeStatus: "SMALL",
    state: "27",
    stateName: "Maharashtra",
    sector: "manufacturing",
    filingBehaviour: "PUNCTUAL",
    numberingStyle: "DASH_FY",
    invoicePrefix: "PPT",
  },
  {
    id: "V06",
    name: "Sahyadri Chemicals & Solvents LLP",
    gstin: FIXTURE_GSTINS.V06,
    msmeStatus: "MEDIUM",
    state: "27",
    stateName: "Maharashtra",
    sector: "manufacturing",
    filingBehaviour: "ERRATIC",
    numberingStyle: "SLASH_FY",
    invoicePrefix: "SCS",
  },
  {
    id: "V07",
    name: "Konkan Office Supplies",
    gstin: FIXTURE_GSTINS.V07,
    msmeStatus: "MICRO",
    state: "27",
    stateName: "Maharashtra",
    sector: "trading",
    filingBehaviour: "LATE",
    numberingStyle: "PLAIN_SEQ",
    invoicePrefix: "",
  },
  {
    id: "V08",
    name: "Vidarbha Power Systems Pvt Ltd",
    gstin: FIXTURE_GSTINS.V08,
    msmeStatus: "NOT_MSME",
    state: "27",
    stateName: "Maharashtra",
    sector: "services",
    filingBehaviour: "PUNCTUAL",
    numberingStyle: "COMPACT_FY",
    invoicePrefix: "VPS",
  },
  {
    id: "V09",
    name: "Mahalaxmi Hardware & Sons",
    gstin: FIXTURE_GSTINS.V09,
    msmeStatus: "MICRO",
    state: "27",
    stateName: "Maharashtra",
    sector: "trading",
    filingBehaviour: "ERRATIC",
    numberingStyle: "PREFIX_SEQ",
    invoicePrefix: "MH",
  },

  // --- Karnataka (29) --------------------------------------------------------
  {
    id: "V10",
    name: "Kaveri Logistics Pvt Ltd",
    gstin: FIXTURE_GSTINS.V10,
    msmeStatus: "SMALL",
    state: "29",
    stateName: "Karnataka",
    sector: "logistics",
    filingBehaviour: "PUNCTUAL",
    numberingStyle: "SLASH_FY",
    invoicePrefix: "KLPL",
  },
  {
    id: "V11",
    name: "Bengaluru Circuit Systems Pvt Ltd",
    gstin: FIXTURE_GSTINS.V11,
    msmeStatus: "MEDIUM",
    state: "29",
    stateName: "Karnataka",
    sector: "manufacturing",
    filingBehaviour: "PUNCTUAL",
    numberingStyle: "DASH_FY",
    invoicePrefix: "BCS",
  },
  {
    id: "V12",
    name: "Sri Vinayaka Enterprises",
    gstin: FIXTURE_GSTINS.V12,
    msmeStatus: "MICRO",
    state: "29",
    stateName: "Karnataka",
    sector: "trading",
    filingBehaviour: "LATE",
    numberingStyle: "PLAIN_SEQ",
    invoicePrefix: "",
  },
  {
    id: "V13",
    name: "Malnad Rubber Products LLP",
    gstin: FIXTURE_GSTINS.V13,
    msmeStatus: "SMALL",
    state: "29",
    stateName: "Karnataka",
    sector: "manufacturing",
    filingBehaviour: "PUNCTUAL",
    numberingStyle: "SLASH_FY",
    invoicePrefix: "MRP",
  },
  {
    id: "V14",
    name: "Nandi Infotech Solutions Pvt Ltd",
    gstin: FIXTURE_GSTINS.V14,
    msmeStatus: "NOT_MSME",
    state: "29",
    stateName: "Karnataka",
    sector: "services",
    filingBehaviour: "PUNCTUAL",
    numberingStyle: "COMPACT_FY",
    invoicePrefix: "NIS",
  },
  {
    id: "V15",
    name: "Hosur Road Warehousing LLP",
    gstin: FIXTURE_GSTINS.V15,
    msmeStatus: "SMALL",
    state: "29",
    stateName: "Karnataka",
    sector: "logistics",
    filingBehaviour: "DEFAULTER",
    numberingStyle: "PREFIX_SEQ",
    invoicePrefix: "HRW",
  },

  // --- Tamil Nadu (33) -------------------------------------------------------
  {
    id: "V16",
    name: "Sundaram Precision Components",
    gstin: FIXTURE_GSTINS.V16,
    msmeStatus: "SMALL",
    state: "33",
    stateName: "Tamil Nadu",
    sector: "manufacturing",
    filingBehaviour: "PUNCTUAL",
    numberingStyle: "PREFIX_SEQ",
    invoicePrefix: "SPC",
  },
  {
    id: "V17",
    name: "Coimbatore Castings Pvt Ltd",
    gstin: FIXTURE_GSTINS.V17,
    msmeStatus: "MEDIUM",
    state: "33",
    stateName: "Tamil Nadu",
    sector: "manufacturing",
    filingBehaviour: "PUNCTUAL",
    numberingStyle: "SLASH_FY",
    invoicePrefix: "CCPL",
  },
  {
    id: "V18",
    name: "Annapoorna Industrial Fasteners",
    gstin: FIXTURE_GSTINS.V18,
    msmeStatus: "MICRO",
    state: "33",
    stateName: "Tamil Nadu",
    sector: "manufacturing",
    filingBehaviour: "ERRATIC",
    numberingStyle: "PLAIN_SEQ",
    invoicePrefix: "",
  },
  {
    id: "V19",
    name: "Madurai Transport Corporation",
    gstin: FIXTURE_GSTINS.V19,
    msmeStatus: "NOT_MSME",
    state: "33",
    stateName: "Tamil Nadu",
    sector: "logistics",
    filingBehaviour: "PUNCTUAL",
    numberingStyle: "SLASH_MONTH",
    invoicePrefix: "MTC",
  },
  {
    id: "V20",
    name: "Velan Electricals & Sons",
    gstin: FIXTURE_GSTINS.V20,
    msmeStatus: "MICRO",
    state: "33",
    stateName: "Tamil Nadu",
    sector: "trading",
    filingBehaviour: "LATE",
    numberingStyle: "PREFIX_SEQ",
    invoicePrefix: "VE",
  },
  {
    id: "V21",
    name: "Chettinad Polymers LLP",
    gstin: FIXTURE_GSTINS.V21,
    msmeStatus: "SMALL",
    state: "33",
    stateName: "Tamil Nadu",
    sector: "manufacturing",
    filingBehaviour: "PUNCTUAL",
    numberingStyle: "DASH_FY",
    invoicePrefix: "CP",
  },

  // --- Gujarat (24) ----------------------------------------------------------
  {
    id: "V22",
    name: "Rajkot Forge & Alloys Pvt Ltd",
    gstin: FIXTURE_GSTINS.V22,
    msmeStatus: "MEDIUM",
    state: "24",
    stateName: "Gujarat",
    sector: "manufacturing",
    filingBehaviour: "PUNCTUAL",
    numberingStyle: "SLASH_FY",
    invoicePrefix: "RFA",
  },
  {
    id: "V23",
    name: "Saurashtra Cotton Traders",
    gstin: FIXTURE_GSTINS.V23,
    msmeStatus: "SMALL",
    state: "24",
    stateName: "Gujarat",
    sector: "trading",
    filingBehaviour: "LATE",
    numberingStyle: "PLAIN_SEQ",
    invoicePrefix: "",
  },
  {
    id: "V24",
    name: "Amrut Chemicals Industries",
    gstin: FIXTURE_GSTINS.V24,
    msmeStatus: "SMALL",
    state: "24",
    stateName: "Gujarat",
    sector: "manufacturing",
    filingBehaviour: "PUNCTUAL",
    numberingStyle: "PREFIX_SEQ",
    invoicePrefix: "ACI",
  },
  {
    id: "V25",
    name: "Vadodara Instrumentation LLP",
    gstin: FIXTURE_GSTINS.V25,
    msmeStatus: "SMALL",
    state: "24",
    stateName: "Gujarat",
    sector: "services",
    filingBehaviour: "ERRATIC",
    numberingStyle: "SLASH_FY",
    invoicePrefix: "VIL",
  },
  {
    id: "V26",
    name: "Gandhinagar Logistics Hub Pvt Ltd",
    gstin: FIXTURE_GSTINS.V26,
    msmeStatus: "MEDIUM",
    state: "24",
    stateName: "Gujarat",
    sector: "logistics",
    filingBehaviour: "PUNCTUAL",
    numberingStyle: "SLASH_MONTH",
    invoicePrefix: "GLH",
  },

  // --- Delhi (07) ------------------------------------------------------------
  {
    id: "V27",
    name: "Kohli Auto Spares & Sons",
    gstin: FIXTURE_GSTINS.V27,
    msmeStatus: "MICRO",
    state: "07",
    stateName: "Delhi",
    sector: "trading",
    filingBehaviour: "LATE",
    numberingStyle: "PREFIX_SEQ",
    invoicePrefix: "KAS",
  },
  {
    id: "V28",
    name: "Capital Facility Services Pvt Ltd",
    gstin: FIXTURE_GSTINS.V28,
    msmeStatus: "MEDIUM",
    state: "07",
    stateName: "Delhi",
    sector: "services",
    filingBehaviour: "PUNCTUAL",
    numberingStyle: "SLASH_FY",
    invoicePrefix: "CFS",
  },
  {
    id: "V29",
    name: "Chandni Chowk Electricals",
    gstin: FIXTURE_GSTINS.V29,
    msmeStatus: "MICRO",
    state: "07",
    stateName: "Delhi",
    sector: "trading",
    filingBehaviour: "DEFAULTER",
    numberingStyle: "PLAIN_SEQ",
    invoicePrefix: "",
  },
  {
    id: "V30",
    name: "Delhi Digital Print Solutions LLP",
    gstin: FIXTURE_GSTINS.V30,
    msmeStatus: "SMALL",
    state: "07",
    stateName: "Delhi",
    sector: "services",
    filingBehaviour: "PUNCTUAL",
    numberingStyle: "DASH_FY",
    invoicePrefix: "DDP",
  },

  // --- Uttar Pradesh (09) ----------------------------------------------------
  {
    id: "V31",
    name: "Ganga Steel Rolling Mills Pvt Ltd",
    gstin: FIXTURE_GSTINS.V31,
    msmeStatus: "MEDIUM",
    state: "09",
    stateName: "Uttar Pradesh",
    sector: "manufacturing",
    filingBehaviour: "PUNCTUAL",
    numberingStyle: "SLASH_FY",
    invoicePrefix: "GSR",
  },
  {
    id: "V32",
    name: "Kanpur Leather Exports LLP",
    gstin: FIXTURE_GSTINS.V32,
    msmeStatus: "SMALL",
    state: "09",
    stateName: "Uttar Pradesh",
    sector: "manufacturing",
    filingBehaviour: "ERRATIC",
    numberingStyle: "PREFIX_SEQ",
    invoicePrefix: "KLE",
  },
  {
    id: "V33",
    name: "Awadh Agro Packaging",
    gstin: FIXTURE_GSTINS.V33,
    msmeStatus: "MICRO",
    state: "09",
    stateName: "Uttar Pradesh",
    sector: "manufacturing",
    filingBehaviour: "LATE",
    numberingStyle: "PLAIN_SEQ",
    invoicePrefix: "",
  },
  {
    id: "V34",
    name: "Noida Techno Cables Pvt Ltd",
    gstin: FIXTURE_GSTINS.V34,
    msmeStatus: "SMALL",
    state: "09",
    stateName: "Uttar Pradesh",
    sector: "manufacturing",
    filingBehaviour: "PUNCTUAL",
    numberingStyle: "COMPACT_FY",
    invoicePrefix: "NTC",
  },

  // --- Haryana (06) ----------------------------------------------------------
  {
    id: "V35",
    name: "Gurgaon Fleet Movers Pvt Ltd",
    gstin: FIXTURE_GSTINS.V35,
    msmeStatus: "MEDIUM",
    state: "06",
    stateName: "Haryana",
    sector: "logistics",
    filingBehaviour: "PUNCTUAL",
    numberingStyle: "SLASH_MONTH",
    invoicePrefix: "GFM",
  },
  {
    id: "V36",
    name: "Yamuna Plastics Industries",
    gstin: FIXTURE_GSTINS.V36,
    msmeStatus: "SMALL",
    state: "06",
    stateName: "Haryana",
    sector: "manufacturing",
    filingBehaviour: "LATE",
    numberingStyle: "SLASH_FY",
    invoicePrefix: "YPI",
  },
  {
    id: "V37",
    name: "Faridabad Metal Craft & Sons",
    gstin: FIXTURE_GSTINS.V37,
    msmeStatus: "MICRO",
    state: "06",
    stateName: "Haryana",
    sector: "manufacturing",
    filingBehaviour: "ERRATIC",
    numberingStyle: "PREFIX_SEQ",
    invoicePrefix: "FMC",
  },

  // --- West Bengal (19) ------------------------------------------------------
  {
    id: "V38",
    name: "Bengal Jute & Fibre Traders",
    gstin: FIXTURE_GSTINS.V38,
    msmeStatus: "SMALL",
    state: "19",
    stateName: "West Bengal",
    sector: "trading",
    filingBehaviour: "LATE",
    numberingStyle: "SLASH_FY",
    invoicePrefix: "BJF",
  },
  {
    id: "V39",
    name: "Howrah Machine Tools Pvt Ltd",
    gstin: FIXTURE_GSTINS.V39,
    msmeStatus: "MEDIUM",
    state: "19",
    stateName: "West Bengal",
    sector: "manufacturing",
    filingBehaviour: "PUNCTUAL",
    numberingStyle: "DASH_FY",
    invoicePrefix: "HMT",
  },
  {
    id: "V40",
    name: "Salt Lake Business Services LLP",
    gstin: FIXTURE_GSTINS.V40,
    msmeStatus: "SMALL",
    state: "19",
    stateName: "West Bengal",
    sector: "services",
    filingBehaviour: "PUNCTUAL",
    numberingStyle: "PREFIX_SEQ",
    invoicePrefix: "SLB",
  },
];

export const VENDOR_BY_ID: ReadonlyMap<string, VendorFixture> = new Map(
  VENDORS.map((v) => [v.id, v]),
);

export const VENDOR_BY_GSTIN: ReadonlyMap<string, VendorFixture> = new Map(
  VENDORS.map((v) => [v.gstin, v]),
);

/** Sec 43B(h) bites for micro and small enterprises only — medium is outside it. */
export function isMsme43bh(status: MsmeStatus): boolean {
  return status === "MICRO" || status === "SMALL";
}

/**
 * Structural self-check for the vendor table: valid GSTINs, unique ids and
 * names, and a `state` field that agrees with the GSTIN it is paired with.
 * The last one matters because `generate.ts` decides IGST vs CGST+SGST from the
 * GSTIN, and a vendor whose two state fields disagree would produce a dataset
 * whose tax split contradicts its own ground truth.
 */
export function assertVendorFixturesValid(): void {
  const problems: string[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();

  for (const v of VENDORS) {
    if (!isValidGstin(v.gstin)) problems.push(`${v.id}: invalid GSTIN ${v.gstin}`);
    if (v.gstin.slice(0, 2) !== v.state) {
      problems.push(`${v.id}: state ${v.state} does not match GSTIN prefix ${v.gstin.slice(0, 2)}`);
    }
    if (STATE_NAMES[v.state] !== v.stateName) {
      problems.push(`${v.id}: stateName "${v.stateName}" is not the name of state ${v.state}`);
    }
    if (ids.has(v.id)) problems.push(`duplicate vendor id ${v.id}`);
    if (names.has(v.name)) problems.push(`duplicate vendor name ${v.name}`);
    if (v.numberingStyle === "PLAIN_SEQ" && v.invoicePrefix !== "") {
      problems.push(`${v.id}: PLAIN_SEQ vendors must have an empty invoicePrefix`);
    }
    if (v.numberingStyle !== "PLAIN_SEQ" && v.invoicePrefix === "") {
      problems.push(`${v.id}: ${v.numberingStyle} needs an invoicePrefix`);
    }
    ids.add(v.id);
    names.add(v.name);
  }

  if (problems.length > 0) {
    throw new Error(`Vendor fixture problems:\n  ${problems.join("\n  ")}`);
  }
}
