/**
 * SSRF guard for the Tally address.
 *
 * Kept in its own module, deliberately free of `server-only`, because it is a
 * pure predicate over a string. The code that opens sockets is server-only;
 * the rule that decides which sockets are allowed should be directly testable,
 * and a security control nobody can unit-test is a security control nobody
 * should trust.
 */

import { TallyError } from "./errors";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/**
 * Allow only loopback and RFC1918 private space, over plain http.
 *
 * The Tally route performs a server-side fetch to a client-supplied address,
 * which is the textbook shape of a server-side request forgery. Without this,
 * a visitor could use our server to reach a cloud metadata endpoint
 * (169.254.169.254) or anything else the host can route to. Tally is by
 * definition a machine-local service, so restricting to private space costs
 * nothing real.
 *
 * Literal IPs only. A hostname is rejected even if it currently resolves to a
 * private address, because DNS can be re-pointed between our check and the
 * fetch — the classic rebinding hole.
 */
export function assertAllowedTallyUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TallyError("URL_NOT_ALLOWED", `"${raw}" is not a valid URL.`);
  }

  if (url.protocol !== "http:") {
    throw new TallyError(
      "URL_NOT_ALLOWED",
      `Only plain http is allowed for Tally; got "${url.protocol}".`,
    );
  }

  const host = url.hostname.toLowerCase();
  if (LOOPBACK.has(host)) return url;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) {
    throw new TallyError(
      "URL_NOT_ALLOWED",
      `"${host}" is not a loopback or private IPv4 address. Use localhost, 127.0.0.1, or the machine's 10.x / 172.16-31.x / 192.168.x address.`,
    );
  }

  const octets = v4.slice(1).map(Number);
  if (octets.some((o) => o > 255)) {
    throw new TallyError("URL_NOT_ALLOWED", `"${host}" is not a valid IPv4 address.`);
  }

  const [a, b] = octets;
  const isPrivate =
    a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);

  if (!isPrivate) {
    throw new TallyError(
      "URL_NOT_ALLOWED",
      `"${host}" is a public address. Tally must be reached on this machine or your local network.`,
    );
  }

  return url;
}
