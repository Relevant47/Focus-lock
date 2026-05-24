import { signJwt } from './crypto';
import {
  consumePairingCode, createDevice, createPairingCode, logAudit, PAIR_CODE_TTL,
} from './db';
import {
  PAIR_POLICY,
  checkRateLimit, pairCodeKey, pairIpKey, recordFailure, recordSuccess,
} from './rateLimit';
import type { Env, PairRedeemRequest } from './types';
import {
  badRequest, clientIp, gone, humanMinutes, json, requireAuth, safeJson,
  sha256Hex, tooManyRequests, unauthorized,
} from './utils';

const DEVICE_TOKEN_TTL_SECONDS = 365 * 24 * 3600;  // 1 year (rotated on heartbeat — Phase 2.3)

export async function pairCreate(req: Request, env: Env): Promise<Response> {
  const ctx = await requireAuth(req, env);
  if (!ctx) return unauthorized();

  const row = await createPairingCode(env.DB, ctx.accountId);
  await logAudit(env.DB, ctx.accountId, null, 'pair_create', { code: row.code }, clientIp(req));
  return json({
    code:        row.code,
    expiresAt:   row.expires_at,
    ttlSeconds:  PAIR_CODE_TTL,
  });
}

export async function pairRedeem(req: Request, env: Env): Promise<Response> {
  const body = await safeJson<PairRedeemRequest>(req);
  if (!body || typeof body.code !== 'string' || typeof body.os !== 'string') {
    return badRequest('code and os required');
  }
  if (body.os !== 'windows' && body.os !== 'macos') {
    return badRequest('os must be "windows" or "macos"');
  }
  const code = body.code.trim();
  if (!/^\d{6}$/.test(code)) return badRequest('code must be 6 digits');

  // Rate-limit BEFORE consuming the code. This endpoint is unauthenticated and
  // brute-forceable (6 digits, 1M space). Two keys, same sliding-window helper
  // used by login/reset: per-IP stops one host spraying codes, per-code stops a
  // distributed guess at one specific code. Check before work so a blocked
  // attacker can't tell a 429 apart from a real consume result.
  const ip = clientIp(req);
  const ipKey = pairIpKey(ip ?? 'unknown');
  const codeKey = pairCodeKey(code);
  const ipState = await checkRateLimit(env, ipKey, PAIR_POLICY);
  if (ipState.blocked) {
    return tooManyRequests(ipState.retryAfterSeconds,
      `Too many pairing attempts. Try again in ${humanMinutes(ipState.retryAfterSeconds)}.`);
  }
  const codeState = await checkRateLimit(env, codeKey, PAIR_POLICY);
  if (codeState.blocked) {
    return tooManyRequests(codeState.retryAfterSeconds,
      `Too many pairing attempts. Try again in ${humanMinutes(codeState.retryAfterSeconds)}.`);
  }

  // Pre-generate the device ID so we can bake it into the JWT *and* record it
  // on the pairing-code row in the same atomic consume step.
  const deviceId = crypto.randomUUID();
  const consumed = await consumePairingCode(env.DB, code, deviceId);
  if (!consumed) {
    // Count every miss (bad or expired code) against both keys.
    const ipAfter = await recordFailure(env, ipKey, PAIR_POLICY);
    const codeAfter = await recordFailure(env, codeKey, PAIR_POLICY);
    if (ipAfter.blocked || codeAfter.blocked) {
      await logAudit(env.DB, null, null, 'pair_redeem_rate_limited',
        { reason: ipAfter.blocked ? 'ip' : 'code' }, ip);
      const retry = Math.max(ipAfter.retryAfterSeconds, codeAfter.retryAfterSeconds);
      return tooManyRequests(retry,
        `Too many pairing attempts. Try again in ${humanMinutes(retry)}.`);
    }
    return gone('invalid or expired pairing code');
  }

  // Successful pair → clear both counters so a parent who fat-fingered the code
  // a couple of times before getting it right isn't left throttled.
  await recordSuccess(env, ipKey);
  await recordSuccess(env, codeKey);

  const deviceToken = await signJwt(
    { sub: consumed.account_id, did: deviceId, kind: 'device' },
    env.JWT_SECRET,
    DEVICE_TOKEN_TTL_SECONDS,
  );
  const tokenHash = await sha256Hex(deviceToken);

  await createDevice(
    env.DB, deviceId, consumed.account_id,
    typeof body.hostname === 'string' ? body.hostname : null,
    body.os,
    typeof body.osVersion === 'string' ? body.osVersion : null,
    ip, tokenHash,
  );

  await logAudit(env.DB, consumed.account_id, deviceId, 'pair_redeem',
    { hostname: body.hostname ?? null, os: body.os, osVersion: body.osVersion ?? null }, ip);

  return json({
    deviceId,
    accountId: consumed.account_id,
    deviceToken,
    expiresInSeconds: DEVICE_TOKEN_TTL_SECONDS,
  });
}
