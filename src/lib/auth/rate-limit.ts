/**
 * In-process rate limiting.
 *
 * Scope, stated plainly because it is easy to over-trust: this is a fixed
 * in-memory counter per server process. It stops credential stuffing and
 * casual abuse against a single-instance deployment, which is what this app
 * actually is today. It does NOT survive a restart, does NOT coordinate
 * across instances or serverless workers, and is NOT a defence against a
 * distributed flood — a real DDoS is absorbed upstream at the CDN or WAF
 * (Cloudflare, Vercel's own protection), never in application code.
 *
 * Treated as one layer, and labelled as one, rather than mistaken for the
 * whole answer.
 */

interface Bucket {
  count: number;
  /** Epoch ms when this window resets. */
  resetAt: number;
  /** Set while a caller is locked out after exhausting the window. */
  blockedUntil?: number;
}

const buckets = new Map<string, Bucket>();

/** Bound the map so a flood of distinct keys cannot itself become the memory leak. */
const MAX_TRACKED_KEYS = 10_000;

export interface RateLimitRule {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Requests permitted per window. */
  max: number;
  /** Extra lockout applied once the window is exhausted. */
  blockMs?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the caller may retry. Only meaningful when `allowed` is false. */
  retryAfterSeconds: number;
}

export function checkRateLimit(key: string, rule: RateLimitRule): RateLimitResult {
  const now = Date.now();

  // Opportunistic sweep of expired entries, amortised across calls so there is
  // no timer holding the process open.
  if (buckets.size > MAX_TRACKED_KEYS) {
    for (const [k, b] of buckets) {
      if (b.resetAt < now && (b.blockedUntil ?? 0) < now) buckets.delete(k);
      if (buckets.size <= MAX_TRACKED_KEYS / 2) break;
    }
  }

  const existing = buckets.get(key);

  if (existing?.blockedUntil && existing.blockedUntil > now) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.ceil((existing.blockedUntil - now) / 1000),
    };
  }

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + rule.windowMs });
    return { allowed: true, remaining: rule.max - 1, retryAfterSeconds: 0 };
  }

  existing.count += 1;

  if (existing.count > rule.max) {
    if (rule.blockMs) existing.blockedUntil = now + rule.blockMs;
    const until = existing.blockedUntil ?? existing.resetAt;
    return { allowed: false, remaining: 0, retryAfterSeconds: Math.ceil((until - now) / 1000) };
  }

  return { allowed: true, remaining: rule.max - existing.count, retryAfterSeconds: 0 };
}

/** Clear a key's counter — called after a successful login so one typo does not haunt the session. */
export function resetRateLimit(key: string): void {
  buckets.delete(key);
}

/**
 * Best-effort client identity for rate limiting.
 *
 * `x-forwarded-for` is trivially spoofable unless a trusted proxy sets it, so
 * this is a throttling hint and never an authorisation input. Behind Vercel or
 * Cloudflare the left-most entry is the real client; direct-to-Node it may be
 * absent entirely, which collapses everyone into one shared bucket — strict,
 * but fail-closed is the right direction for a login endpoint.
 */
export function clientKey(request: Request, prefix: string): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
  return `${prefix}:${ip}`;
}

/** Five attempts a minute, then a fifteen-minute lockout. */
export const LOGIN_RULE: RateLimitRule = { windowMs: 60_000, max: 5, blockMs: 15 * 60_000 };

/** Tally pulls are slow and legitimate ones are rare; this only catches runaway loops. */
export const TALLY_RULE: RateLimitRule = { windowMs: 60_000, max: 20 };
