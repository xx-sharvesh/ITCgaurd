/**
 * GSTIN fixtures.
 *
 * Two things live here:
 *
 *  1. `makeValidGstin` — builds a structurally correct GSTIN with a real check
 *     digit by delegating to the production `computeGstinCheckDigit`. Tests that
 *     need an ad-hoc vendor should use this rather than inventing a 15-char
 *     string, because a hand-typed GSTIN almost always fails the checksum and
 *     the resulting test failure looks like an engine bug.
 *
 *  2. `FIXTURE_GSTINS` — 40 pre-built GSTINs for the named vendors in
 *     `vendors.ts`, written out as literals.
 *
 * Why literals rather than calls to `makeValidGstin` at module load: a literal
 * is a frozen expectation. If someone changes the checksum algorithm in
 * `domain/gstin.ts`, `assertFixtureGstinsValid()` fails loudly. Had we generated
 * them from the same function under test, the fixtures would silently follow the
 * bug and every downstream assertion would still pass.
 *
 * The PANs are shaped the way real Indian PANs are: the 4th character encodes
 * the holder type (C company, F firm/LLP, P individual/proprietor, H HUF) and
 * the 5th echoes the first letter of the entity or surname. CFOs read PANs at a
 * glance and a demo full of "AAAAA0000A" reads as fake.
 */

import {
  computeGstinCheckDigit,
  isValidGstin,
  normalizeGstin,
  STATE_NAMES,
} from "../domain/gstin";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const PAN_SHAPE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
/** Company, Firm/LLP, Individual (proprietor), HUF, AOP — the 4th PAN character. */
const HOLDER_TYPES = "CFPHA";

/**
 * Build a GSTIN with a correct check digit.
 *
 * `panSeed` may be a real 10-character PAN, in which case it is used verbatim,
 * or any other string, which is hashed into a stable PAN. The hash means the
 * same seed always yields the same GSTIN — fixtures must not drift between runs.
 *
 * Throws rather than returning null: every caller here is fixture code, and a
 * silently skipped vendor is far worse than a loud build failure.
 */
export function makeValidGstin(stateCode: string, panSeed: string, entityCode = "1"): string {
  const state = stateCode.trim().padStart(2, "0");
  if (!(state in STATE_NAMES)) {
    throw new Error(`makeValidGstin: "${stateCode}" is not a GST state code`);
  }

  const seed = panSeed.trim().toUpperCase();
  const pan = PAN_SHAPE.test(seed) ? seed : derivePan(seed);
  if (!PAN_SHAPE.test(pan)) {
    throw new Error(`makeValidGstin: derived PAN "${pan}" is malformed`);
  }

  const entity = entityCode.trim().toUpperCase();
  if (!/^[1-9A-Z]$/.test(entity)) {
    throw new Error(`makeValidGstin: entity code "${entityCode}" must be 1-9 or A-Z`);
  }

  // Position 13 is 'Z' for every ordinary registration; the portal reserves
  // other letters for cases we do not model.
  const first14 = `${state}${pan}${entity}Z`;
  const check = computeGstinCheckDigit(first14);
  if (check === null) {
    throw new Error(`makeValidGstin: could not compute a check digit for "${first14}"`);
  }
  return first14 + check;
}

/**
 * Deterministically expand an arbitrary seed into a PAN-shaped string.
 * FNV-1a for the initial mix, xorshift32 to pull the individual characters.
 */
function derivePan(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193) >>> 0;
  }

  const step = (): number => {
    h = (h ^ (h << 13)) >>> 0;
    h = h ^ (h >>> 17);
    h = (h ^ (h << 5)) >>> 0;
    return h;
  };

  let pan = "";
  for (let i = 0; i < 3; i++) pan += LETTERS[step() % 26];
  pan += HOLDER_TYPES[step() % HOLDER_TYPES.length];

  // 5th character conventionally mirrors the entity's initial, so a derived
  // PAN for "Kaveri Logistics" still reads as belonging to Kaveri Logistics.
  const initial = seed.replace(/[^A-Z]/g, "").charAt(0);
  pan += initial !== "" ? initial : LETTERS[step() % 26];

  for (let i = 0; i < 4; i++) pan += String(step() % 10);
  pan += LETTERS[step() % 26];
  return pan;
}

/**
 * Pre-built vendor GSTINs, keyed by the vendor id used in `vendors.ts`.
 *
 * Spread across the eight states a Pune-based mid-market manufacturer actually
 * buys from: 27 Maharashtra (intra-state, CGST+SGST), and 29/33/24/07/09/06/19
 * inter-state (IGST).
 *
 * V06 and V31 carry entity code 2 — a second registration of the same PAN in
 * the same state, which is legal and turns up in real registers.
 */
export const FIXTURE_GSTINS = {
  // Maharashtra (27) — intra-state supplies for our Pune buyer.
  V01: "27AKPPB2417M1Z0",
  V02: "27AAGFN3186K1ZV",
  V03: "27AFTPG5029H1Z7",
  V04: "27AABCD9134R1Z2",
  V05: "27AACCP7521N1Z2",
  V06: "27AAJFS6640Q2ZD",
  V07: "27AHQPK1873D1Z6",
  V08: "27AADCV4098J1ZT",
  V09: "27AAEHM2765B1ZE",
  // Karnataka (29)
  V10: "29AABCK5713F1ZN",
  V11: "29AAGCB8402L1ZE",
  V12: "29AMSPV3164T1ZL",
  V13: "29AAKFM7238C1Z4",
  V14: "29AAECN1957G1Z9",
  V15: "29AALFH6082P1ZH",
  // Tamil Nadu (33)
  V16: "33AAHFS4471D1ZD",
  V17: "33AABCC9350M1ZI",
  V18: "33ANWPA2618K1ZW",
  V19: "33AACCM7194B1ZO",
  V20: "33AADHV5836N1ZM",
  V21: "33AAMFC3027J1ZL",
  // Gujarat (24)
  V22: "24AABCR6459H1Z9",
  V23: "24AGRPS8107L1ZR",
  V24: "24AAFFA2984R1ZX",
  V25: "24AANFV5310E1ZD",
  V26: "24AAECG7623Q1Z6",
  // Delhi (07)
  V27: "07AABHK4192T1ZJ",
  V28: "07AAGCC8735D1ZO",
  V29: "07AJYPC1408W1ZD",
  V30: "07AAPFD6971M1ZN",
  // Uttar Pradesh (09)
  V31: "09AABCG3547K2ZD",
  V32: "09AAQFK9028N1ZF",
  V33: "09AKLPA6215J1Z5",
  V34: "09AADCN1786F1ZB",
  // Haryana (06)
  V35: "06AAFCG5904P1Z9",
  V36: "06AARFY2360B1Z6",
  V37: "06AACHF8143L1Z6",
  // West Bengal (19)
  V38: "19AASFB4629C1ZB",
  V39: "19AABCH7015S1Z1",
  V40: "19AATFS3892G1ZE",
} as const;

export type FixtureGstinKey = keyof typeof FIXTURE_GSTINS;

export const ALL_FIXTURE_GSTINS: readonly string[] = Object.values(FIXTURE_GSTINS);

/**
 * The buyer: a Pune manufacturer. Every place-of-supply in the generated
 * dataset resolves against state 27, which is what makes the intra/inter-state
 * tax split in `generate.ts` correct rather than arbitrary.
 */
export const BUYER_GSTIN = "27AABCV7182N1ZO";
export const BUYER_NAME = "Vasudha Engineering Industries Pvt Ltd";
export const BUYER_STATE_CODE = "27";

/**
 * Corrupt a GSTIN so that it keeps the 15-character shape but fails the
 * checksum — i.e. exactly what a mistyped GSTIN in a purchase register looks
 * like. Used to seed the BAD_GSTIN defect class.
 *
 * Deterministic in `nudge`, so the same call always produces the same typo.
 * Changing a single character always changes the checksum (each position's
 * contribution to the sum is injective in the character value), but we verify
 * anyway and walk to the next candidate rather than trusting the argument.
 */
export function corruptGstinChecksum(gstin: string, nudge = 1): string {
  const g = normalizeGstin(gstin);
  if (g.length !== 15) throw new Error(`corruptGstinChecksum: "${gstin}" is not 15 characters`);

  // Only touch PAN letter positions 2..6 so the result still matches the GSTIN
  // shape and fails with BAD_CHECKSUM rather than BAD_FORMAT.
  for (let attempt = 0; attempt < 26 * 5; attempt++) {
    const pos = 2 + ((nudge + attempt) % 5);
    const shift = 1 + ((nudge + attempt) % 25);
    const original = LETTERS.indexOf(g[pos]);
    if (original === -1) continue;
    const replacement = LETTERS[(original + shift) % 26];
    const candidate = g.slice(0, pos) + replacement + g.slice(pos + 1);
    if (!isValidGstin(candidate)) return candidate;
  }
  throw new Error(`corruptGstinChecksum: could not produce an invalid variant of "${gstin}"`);
}

/**
 * The non-negotiable self-check: every GSTIN this module hands out must pass
 * the production validator. Called by `selfcheck.ts`; call it from any test
 * suite that leans on these fixtures.
 */
export function assertFixtureGstinsValid(): void {
  const bad: string[] = [];
  for (const [key, gstin] of Object.entries(FIXTURE_GSTINS)) {
    if (!isValidGstin(gstin)) bad.push(`${key}=${gstin}`);
  }
  if (!isValidGstin(BUYER_GSTIN)) bad.push(`BUYER=${BUYER_GSTIN}`);
  if (bad.length > 0) {
    throw new Error(`Invalid GSTIN fixtures: ${bad.join(", ")}`);
  }

  const seen = new Set(ALL_FIXTURE_GSTINS);
  if (seen.size !== ALL_FIXTURE_GSTINS.length) {
    throw new Error("Duplicate GSTIN in FIXTURE_GSTINS");
  }
}
