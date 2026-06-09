import {
  createRule, deleteDevice, deleteRule, findDeviceById, listActiveRulesForDevice,
  listDevicesForAccount, logAudit,
} from './db';
import type {
  CreateRuleRequest, DeviceRow, DeviceSummary, Env, LockRule,
} from './types';
import {
  badRequest, clientIp, forbidden, json, notFound, requireAuth, requireDeviceAuth, safeJson,
  unauthorized,
} from './utils';

const ONLINE_WINDOW_MS = 90_000;  // device considered online if seen within 90s

function toSummary(d: DeviceRow): DeviceSummary {
  const seen = d.last_seen_at ? Date.parse(d.last_seen_at) : 0;
  return {
    id: d.id,
    hostname: d.hostname,
    os: d.os,
    osVersion: d.os_version,
    pairedAt: d.paired_at,
    lastSeenAt: d.last_seen_at,
    online: seen > 0 && (Date.now() - seen) < ONLINE_WINDOW_MS,
  };
}

// ── Parent endpoints ───────────────────────────────────────────────────────

export async function listDevices(req: Request, env: Env): Promise<Response> {
  const ctx = await requireAuth(req, env);
  if (!ctx) return unauthorized();
  const rows = await listDevicesForAccount(env.DB, ctx.accountId);
  return json({ devices: rows.map(toSummary) });
}

export async function deleteDeviceHandler(
  req: Request, env: Env, params: Record<string, string>,
): Promise<Response> {
  const ctx = await requireAuth(req, env);
  if (!ctx) return unauthorized();
  const ok = await deleteDevice(env.DB, params.id, ctx.accountId);
  if (!ok) return notFound();
  await logAudit(env.DB, ctx.accountId, params.id, 'device_unpair', null, clientIp(req));
  // Tell the Durable Object so any active WS connection can close itself.
  await notifyDevice(env, params.id, { type: 'unpair' }).catch(() => { /* DO may not exist */ });
  return json({ ok: true });
}

export async function createRuleHandler(
  req: Request, env: Env, params: Record<string, string>,
): Promise<Response> {
  const ctx = await requireAuth(req, env);
  if (!ctx) return unauthorized();
  // Verify the device belongs to this account.
  const device = await findDeviceById(env.DB, params.id);
  if (!device) return notFound();
  if (device.account_id !== ctx.accountId) return forbidden();

  const body = await safeJson<CreateRuleRequest>(req);
  if (!body || typeof body.kind !== 'string') return badRequest('kind required');
  if (body.kind !== 'block_now' && body.kind !== 'schedule'
      && body.kind !== 'unblock_all' && body.kind !== 'unblock_specific') {
    return badRequest('kind must be block_now | schedule | unblock_all | unblock_specific');
  }
  if (body.kind === 'schedule' && typeof body.scheduleCron !== 'string') {
    return badRequest('scheduleCron required for kind=schedule');
  }
  if (body.kind === 'unblock_specific' && typeof body.expiresAt !== 'string') {
    return badRequest('expiresAt required for kind=unblock_specific');
  }
  const apps = Array.isArray(body.targetApps) ? body.targetApps.filter(s => typeof s === 'string') : undefined;
  const domains = Array.isArray(body.targetDomains) ? body.targetDomains.filter(s => typeof s === 'string') : undefined;

  const rule = await createRule(
    env.DB, params.id, ctx.accountId, body.kind,
    apps, domains,
    body.kind === 'schedule' ? body.scheduleCron! : null,
    body.kind === 'unblock_specific' ? body.expiresAt! : null,
  );
  await logAudit(env.DB, ctx.accountId, params.id, 'rule_create',
    { ruleId: rule.id, kind: rule.kind }, clientIp(req));

  // Push to connected child (if any). Failure is non-fatal — child re-syncs on next reconnect.
  await notifyDevice(env, params.id, { type: 'rule_change', rule }).catch(err => {
    console.warn('notifyDevice failed', params.id, err);
  });

  return json({ rule });
}

export async function listRulesHandler(
  req: Request, env: Env, params: Record<string, string>,
): Promise<Response> {
  const ctx = await requireAuth(req, env);
  if (!ctx) return unauthorized();
  const device = await findDeviceById(env.DB, params.id);
  if (!device || device.account_id !== ctx.accountId) return notFound();
  const rules = await listActiveRulesForDevice(env.DB, params.id);
  return json({ rules });
}

export async function deleteRuleHandler(
  req: Request, env: Env, params: Record<string, string>,
): Promise<Response> {
  const ctx = await requireAuth(req, env);
  if (!ctx) return unauthorized();
  const device = await findDeviceById(env.DB, params.id);
  if (!device || device.account_id !== ctx.accountId) return notFound();
  const ok = await deleteRule(env.DB, params.ruleId, params.id);
  if (!ok) return notFound();
  await logAudit(env.DB, ctx.accountId, params.id, 'rule_delete',
    { ruleId: params.ruleId }, clientIp(req));
  await notifyDevice(env, params.id, { type: 'rule_delete', ruleId: params.ruleId }).catch(() => {});
  return json({ ok: true });
}

// ── Device-side endpoint: child daemon pulls its current rules on reconnect ─

export async function listMyRulesHandler(req: Request, env: Env): Promise<Response> {
  const ctx = await requireDeviceAuth(req, env);
  if (!ctx) return unauthorized();
  const rules = await listActiveRulesForDevice(env.DB, ctx.deviceId);
  return json({ rules });
}

// ── Internal: push to a device's Durable Object ────────────────────────────

async function notifyDevice(env: Env, deviceId: string, message: object): Promise<void> {
  const id = env.DEVICE_CONN.idFromName(deviceId);
  const stub = env.DEVICE_CONN.get(id);
  await stub.fetch('http://device-conn/notify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
  });
}
