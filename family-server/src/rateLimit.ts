// Phase 2.9 — per-email rate limiting on /auth/login and /auth/reset-request.
//
// Same key whether the email exists or not — otherwise an attacker can probe
// account existence by which path returns 429 vs. 401.
//
// Logic (sliding window):
//   1. Look up row by key.
//   2. If blocked_until > now, return blocked with retry-after seconds.
//   3. If window_start older than window, the row is stale — pretend it
//      doesn't exist and start fresh.
//   4. Caller does its real work (verify password / look up email).
//   5. Caller calls recordFailure() on bad creds or recordSuccess() on good.
//
// Race: two parallel requests could both see attempts < max before either
// increments — worst case one extra attempt slips through, not worth the
// complexity of D1 transactions.
//
// D1 read-after-write lag: in practice, a request reading immediately after
// the previous request's write may see stale `attempts`. This shifts the
// effective threshold up by ~1 attempt, but still locks the attacker out
// after a small finite number — acceptable for our threat model. Switching
// to Durable Objects per-key would close this if it ever matters.

import type { Env, RateLimitRow } from './types';

export interface RateLimitPolicy {
  /// How many attempts are allowed inside `windowSeconds` before blocking.
  maxAttempts: number;
  /// Window length. Attempts older than this are forgotten.
  windowSeconds: number;
  /// How long the key is blocked once `maxAttempts` is reached.
  blockSeconds: number;
}

export const LOGIN_POLICY: RateLimitPolicy = {
  maxAttempts: 5,
  windowSeconds: 15 * 60,   // 15 minutes
  blockSeconds: 30 * 60,    // 30 minutes
};

export const RESET_POLICY: RateLimitPolicy = {
  maxAttempts: 3,
  windowSeconds: 60 * 60,   // 1 hour
  blockSeconds: 60 * 60,    // 1 hour
};

// Pair-redeem is unauthenticated and validates a 6-digit code (1M-space,
// 10-minute TTL). Without per-IP throttling an attacker who knows a parent is
// currently pairing can enumerate the whole space during the window. 10
// attempts / 5 min with a 30-minute lockout keeps the effective search rate
// well below the space size while still tolerating a real user mistyping a
// couple of times.
export const PAIR_REDEEM_POLICY: RateLimitPolicy = {
  maxAttempts: 10,
  windowSeconds: 5 * 60,    // 5 minutes
  blockSeconds: 30 * 60,    // 30 minutes
};

export interface RateLimitState {
  blocked: boolean;
  /// Seconds the caller should wait before the key unblocks. 0 when not blocked.
  retryAfterSeconds: number;
}

/// Reads the current state for a key. Doesn't mutate.
export async function checkRateLimit(
  env: Env,
  key: string,
  policy: RateLimitPolicy,
): Promise<RateLimitState> {
  const row = await env.DB.prepare('SELECT * FROM auth_rate_limits WHERE key = ?')
    .bind(key).first() as RateLimitRow | null;
  if (!row) return { blocked: false, retryAfterSeconds: 0 };

  const now = Date.now();
  if (row.blocked_until) {
    const until = Date.parse(row.blocked_until);
    if (until > now) {
      return { blocked: true, retryAfterSeconds: Math.ceil((until - now) / 1000) };
    }
  }
  // Block has expired (or there was none). Stale window → caller can proceed,
  // recordFailure/Success below will overwrite.
  const start = Date.parse(row.window_start);
  if (now - start > policy.windowSeconds * 1000) {
    return { blocked: false, retryAfterSeconds: 0 };
  }
  return { blocked: false, retryAfterSeconds: 0 };
}

/// Records a failed attempt. Returns the new state — if it just crossed the
/// limit, blocked=true and retryAfter is the block duration. Caller uses the
/// return value to decide whether to log a `*_rate_limited` audit event.
export async function recordFailure(
  env: Env,
  key: string,
  policy: RateLimitPolicy,
): Promise<RateLimitState> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const row = await env.DB.prepare('SELECT * FROM auth_rate_limits WHERE key = ?')
    .bind(key).first() as RateLimitRow | null;

  // No prior row or stale window → start fresh.
  const windowStart = row && (now - Date.parse(row.window_start)) <= policy.windowSeconds * 1000
    ? row.window_start
    : nowIso;
  const attempts = (row && row.window_start === windowStart ? row.attempts : 0) + 1;

  if (attempts >= policy.maxAttempts) {
    const blockedUntil = new Date(now + policy.blockSeconds * 1000).toISOString();
    await env.DB.prepare(
      `INSERT INTO auth_rate_limits (key, attempts, window_start, blocked_until)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET attempts = excluded.attempts,
                                       window_start = excluded.window_start,
                                       blocked_until = excluded.blocked_until`,
    ).bind(key, attempts, windowStart, blockedUntil).run();
    return { blocked: true, retryAfterSeconds: policy.blockSeconds };
  }

  await env.DB.prepare(
    `INSERT INTO auth_rate_limits (key, attempts, window_start, blocked_until)
     VALUES (?, ?, ?, NULL)
     ON CONFLICT(key) DO UPDATE SET attempts = excluded.attempts,
                                     window_start = excluded.window_start,
                                     blocked_until = NULL`,
  ).bind(key, attempts, windowStart).run();
  return { blocked: false, retryAfterSeconds: 0 };
}

/// Clears a key. Called on successful login so the user isn't punished for
/// previous typos.
export async function recordSuccess(env: Env, key: string): Promise<void> {
  await env.DB.prepare('DELETE FROM auth_rate_limits WHERE key = ?').bind(key).run();
}

export function loginKey(email: string): string { return `login:${email.toLowerCase()}`; }
export function resetKey(email: string): string { return `reset:${email.toLowerCase()}`; }
export function pairRedeemKey(ip: string): string { return `pair_redeem:${ip}`; }
