/**
 * Typed failures for the TallyPrime connector.
 *
 * Every failure mode here maps to a *different thing the operator must do*.
 * "Could not fetch from Tally" is useless to a finance clerk at 6pm on the
 * 10th; "Tally is running but ActAsServer is off — Gateway of Tally, F1, ..."
 * gets them unblocked. So the kind is not decoration: the UI branches on it and
 * the hint is shown verbatim.
 */

export type TallyErrorKind =
  /** Caller handed us something structurally wrong (bad date, empty company). */
  | "BAD_REQUEST"
  /** SSRF guard rejected the target URL. */
  | "URL_NOT_ALLOWED"
  /** TCP refused — Tally not running, or running without the HTTP gateway. */
  | "CONNECTION_REFUSED"
  /** DNS/host/socket failure that is not a plain refusal. */
  | "NETWORK_ERROR"
  /** We gave up waiting. Tally is single-threaded per request and can stall. */
  | "TIMEOUT"
  /** Tally answered, but with a non-2xx status. */
  | "HTTP_ERROR"
  /** Response exceeded the hard byte cap before we finished reading it. */
  | "RESPONSE_TOO_LARGE"
  /** Body arrived but is not XML we can walk. */
  | "PARSE_ERROR"
  /** Tally itself reported an error (<LINEERROR>, STATUS 0). */
  | "TALLY_ERROR"
  /** Tally answered 200 with nothing usable — almost always "company not open". */
  | "EMPTY_RESULT";

/**
 * Operator-facing next step per kind. Deliberately imperative and specific to
 * Tally; a generic "check your connection" is what we are trying to avoid.
 */
export const TALLY_ERROR_HINT: Record<TallyErrorKind, string> = {
  BAD_REQUEST: "Check the company name and the date range, then try again.",
  URL_NOT_ALLOWED:
    "The Tally address must be on this machine or your local network — localhost, 127.0.0.1, or a private 10.x / 172.16-31.x / 192.168.x address over plain http.",
  CONNECTION_REFUSED:
    "Nothing is listening on that port. Open Tally, then Gateway of Tally > F1 Help > Settings > Connectivity > Client/Server configuration, set 'TallyPrime acts as' to 'Both' and Port to 9000, and accept.",
  NETWORK_ERROR:
    "Could not reach that host. Confirm the machine running Tally is switched on and reachable, and that its firewall allows inbound TCP on the Tally port.",
  TIMEOUT:
    "Tally did not answer in time. Large date ranges on big companies can exceed a minute — pull one month at a time, and make sure nobody is sitting in a modal dialog inside Tally (it stops answering requests while a prompt is open).",
  HTTP_ERROR: "Tally answered with an HTTP error. Confirm the port belongs to Tally and not some other local service.",
  RESPONSE_TOO_LARGE:
    "The export is larger than the 50 MB safety cap. Pull a shorter date range — a month at a time.",
  PARSE_ERROR:
    "Tally's response was not XML we could read. Confirm the port belongs to Tally, and that the request reached the right company.",
  TALLY_ERROR: "Tally rejected the request. The message above is Tally's own wording.",
  EMPTY_RESULT:
    "Tally answered but sent no data. The usual cause is that the company is not open in Tally — open it on the Tally machine and retry. Company names must match exactly, including punctuation.",
};

/** HTTP status the API route should return for each kind. */
export const TALLY_ERROR_STATUS: Record<TallyErrorKind, number> = {
  BAD_REQUEST: 400,
  URL_NOT_ALLOWED: 400,
  CONNECTION_REFUSED: 502,
  NETWORK_ERROR: 502,
  TIMEOUT: 504,
  HTTP_ERROR: 502,
  RESPONSE_TOO_LARGE: 413,
  PARSE_ERROR: 502,
  TALLY_ERROR: 502,
  EMPTY_RESULT: 502,
};

export interface TallyErrorOptions {
  /** Extra context safe to show the operator (never a stack trace). */
  detail?: string;
  /** Upstream HTTP status when kind is HTTP_ERROR. */
  httpStatus?: number;
  cause?: unknown;
}

export class TallyError extends Error {
  readonly kind: TallyErrorKind;
  readonly detail?: string;
  readonly httpStatus?: number;

  constructor(kind: TallyErrorKind, message: string, options: TallyErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "TallyError";
    this.kind = kind;
    this.detail = options.detail;
    this.httpStatus = options.httpStatus;
  }

  get hint(): string {
    return TALLY_ERROR_HINT[this.kind];
  }

  /** The shape the API route returns. Contains nothing that leaks internals. */
  toJSON(): { kind: TallyErrorKind; message: string; hint: string; detail?: string } {
    return {
      kind: this.kind,
      message: this.message,
      hint: this.hint,
      ...(this.detail === undefined ? {} : { detail: this.detail }),
    };
  }
}

export function isTallyError(value: unknown): value is TallyError {
  return value instanceof TallyError;
}
