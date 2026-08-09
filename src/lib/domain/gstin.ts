/**
 * GSTIN structure and checksum validation.
 *
 * A GSTIN is 15 characters:
 *   [0-1]   state code, 2 digits
 *   [2-11]  PAN of the entity, 10 chars (AAAAA9999A)
 *   [12]    entity code — nth registration of this PAN in this state (1-9, A-Z)
 *   [13]    'Z' by default
 *   [14]    check digit
 *
 * Validating the checksum locally catches transcription errors in the purchase
 * register before we ever accuse a vendor of not filing. A typo'd GSTIN looks
 * exactly like a missing invoice in a naive reconciliation, and chasing a
 * vendor over your own typo is the fastest way to lose their trust.
 */

const CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

/**
 * State codes per the GST state code list. 01-38 are states/UTs currently in
 * use; 97 is "Other Territory" and 99 is used for Centre jurisdiction.
 * Codes are validated against this set because an out-of-range code is a
 * guaranteed data error, not an obscure valid registration.
 */
const STATE_NAMES: Record<string, string> = {
  "01": "Jammu & Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "25": "Daman & Diu",
  "26": "Dadra & Nagar Haveli and Daman & Diu",
  "27": "Maharashtra",
  "28": "Andhra Pradesh (old)",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman & Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
  "97": "Other Territory",
  "99": "Centre Jurisdiction",
};

export interface GstinValidation {
  valid: boolean;
  /** Uppercased, whitespace-stripped input. */
  normalized: string;
  stateCode?: string;
  stateName?: string;
  pan?: string;
  /** Populated only when invalid — shown verbatim to the user. */
  error?: GstinError;
}

export type GstinError =
  | "EMPTY"
  | "BAD_LENGTH"
  | "BAD_FORMAT"
  | "UNKNOWN_STATE_CODE"
  | "BAD_CHECKSUM";

export const GSTIN_ERROR_TEXT: Record<GstinError, string> = {
  EMPTY: "No GSTIN provided",
  BAD_LENGTH: "GSTIN must be exactly 15 characters",
  BAD_FORMAT: "GSTIN does not match the 15-character GSTIN pattern",
  UNKNOWN_STATE_CODE: "First two digits are not a valid GST state code",
  BAD_CHECKSUM: "Check digit is wrong — likely a typo in the GSTIN",
};

/** Strip spaces/hyphens and uppercase. Registers are full of "27 AABCS…". */
export function normalizeGstin(raw: string): string {
  return (raw ?? "").replace(/[\s-]/g, "").toUpperCase();
}

/**
 * Compute the 15th character from the first 14.
 *
 * Algorithm: each character maps to its index in the 36-char set. Positions
 * alternate weight 1,2,1,2… starting at 1. For each product, add the quotient
 * and remainder of division by 36. The check digit is whatever brings the
 * running total to a multiple of 36.
 */
export function computeGstinCheckDigit(first14: string): string | null {
  if (first14.length !== 14) return null;

  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = CHARSET.indexOf(first14[i]);
    if (value === -1) return null;
    const weight = (i % 2) + 1;
    const product = value * weight;
    sum += Math.floor(product / 36) + (product % 36);
  }

  const checkValue = (36 - (sum % 36)) % 36;
  return CHARSET[checkValue];
}

export function validateGstin(raw: string): GstinValidation {
  const normalized = normalizeGstin(raw);

  if (!normalized) {
    return { valid: false, normalized, error: "EMPTY" };
  }
  if (normalized.length !== 15) {
    return { valid: false, normalized, error: "BAD_LENGTH" };
  }
  if (!GSTIN_SHAPE.test(normalized)) {
    return { valid: false, normalized, error: "BAD_FORMAT" };
  }

  const stateCode = normalized.slice(0, 2);
  if (!(stateCode in STATE_NAMES)) {
    return { valid: false, normalized, stateCode, error: "UNKNOWN_STATE_CODE" };
  }

  const expected = computeGstinCheckDigit(normalized.slice(0, 14));
  if (expected === null || expected !== normalized[14]) {
    return {
      valid: false,
      normalized,
      stateCode,
      stateName: STATE_NAMES[stateCode],
      pan: normalized.slice(2, 12),
      error: "BAD_CHECKSUM",
    };
  }

  return {
    valid: true,
    normalized,
    stateCode,
    stateName: STATE_NAMES[stateCode],
    pan: normalized.slice(2, 12),
  };
}

export function isValidGstin(raw: string): boolean {
  return validateGstin(raw).valid;
}

/** The PAN embedded in a GSTIN. Two GSTINs sharing a PAN are the same legal entity. */
export function panFromGstin(raw: string): string | null {
  const n = normalizeGstin(raw);
  return n.length === 15 ? n.slice(2, 12) : null;
}

export function stateNameFromGstin(raw: string): string | undefined {
  return STATE_NAMES[normalizeGstin(raw).slice(0, 2)];
}

/**
 * Whether a supply is inter-state, from the supplier's GSTIN and the place of
 * supply state code. Inter-state carries IGST; intra-state carries CGST+SGST.
 * Getting this backwards is a common books error that produces a real mismatch.
 */
export function isInterState(supplierGstin: string, placeOfSupplyCode?: string): boolean | null {
  const supplierState = normalizeGstin(supplierGstin).slice(0, 2);
  if (!supplierState || !placeOfSupplyCode) return null;
  const pos = placeOfSupplyCode.padStart(2, "0").slice(0, 2);
  if (!(supplierState in STATE_NAMES) || !(pos in STATE_NAMES)) return null;
  return supplierState !== pos;
}

export { STATE_NAMES };
