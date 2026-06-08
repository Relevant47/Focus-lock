import { signJwt } from './crypto';
import {
  consumePairingCode, createDevice, createNotification, createPairingCode, logAudit, PAIR_CODE_TTL,
} from './db';
import type { DevicePairedPayload, Env, PairRedeemRequest } from './types';
import {
  badRequest, clientIp, gone, json, requireAuth, safeJson, sha256Hex, unauthorized,
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

  // Pre-generate the device ID so we can bake it into the JWT *and* record it
  // on the pairing-code row in the same atomic consume step.
  const deviceId = crypto.randomUUID();
  const consumed = await consumePairingCode(env.DB, code, deviceId);
  if (!consumed) return gone('invalid or expired pairing code');

  const deviceToken = await signJwt(
    { sub: consumed.account_id, did: deviceId, kind: 'device' },
    env.JWT_SECRET,
    DEVICE_TOKEN_TTL_SECONDS,
  );
  const tokenHash = await sha256Hex(deviceToken);
  const ip = clientIp(req);

  await createDevice(
    env.DB, deviceId, consumed.account_id,
    typeof body.hostname === 'string' ? body.hostname : null,
    body.os,
    typeof body.osVersion === 'string' ? body.osVersion : null,
    ip, tokenHash,
  );

  await logAudit(env.DB, consumed.account_id, deviceId, 'pair_redeem',
    { hostname: body.hostname ?? null, os: body.os, osVersion: body.osVersion ?? null }, ip);

  // Phase 3.1 — surface the pair as an unread Inbox card on the parent UI.
  // Best-effort: a notification write failure must not affect the device's
  // ability to come online, so swallow errors and log them only.
  const hostname = typeof body.hostname === 'string' ? body.hostname : null;
  const osVersion = typeof body.osVersion === 'string' ? body.osVersion : null;
  const nowIso = new Date().toISOString();
  const payload: DevicePairedPayload = {
    deviceId,
    hostname,
    os: body.os,
    osVersion,
    pairedAt: nowIso,
  };
  await createNotification(
    env.DB, consumed.account_id, 'device_paired',
    hostname ? `${hostname} just paired` : 'A new device paired',
    hostname
      ? `${hostname} (${body.os}) is now linked to your family. You can block apps on it from the Family tab.`
      : `A new ${body.os} device is now linked to your family.`,
    payload,
  ).catch((err: unknown) => { console.warn('notification create failed', err); });

  return json({
    deviceId,
    accountId: consumed.account_id,
    deviceToken,
    expiresInSeconds: DEVICE_TOKEN_TTL_SECONDS,
  });
}
