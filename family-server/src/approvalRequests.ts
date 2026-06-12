// Phase 3.2 — child-initiated approval requests. Five endpoints split by auth:
//
// Device-authed (kid daemon):
//   POST /api/v1/family/requests              → create + dedup
//   GET  /api/v1/device/requests/:id          → poll status
//
// Parent-authed:
//   GET  /api/v1/family/requests/:id          → hydrate one row
//   POST /api/v1/family/requests/:id/approve  → atomic flip + create rule
//   POST /api/v1/family/requests/:id/deny     → atomic flip

import {
  createApprovalRequest, createNotification, createRule, findApprovalRequestById,
  findPendingApprovalForTarget, markApprovalResolved,
} from './db';
import type {
  ApprovalRequest, ApprovalRequestRow, CreateApprovalRequestBody, Env,
} from './types';
import {
  badRequest, clientIp, conflict, json, notFound,
  requireAuth, requireDeviceAuth, safeJson, unauthorized,
} from './utils';

const ALLOWED_MINUTES = new Set([15, 30, 60]);

function toApi(row: ApprovalRequestRow): ApprovalRequest {
  return {
    id: row.id,
    deviceId: row.device_id,
    targetKind: row.target_kind,
    target: row.target,
    requestedMinutes: row.requested_minutes,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    resolutionRuleId: row.resolution_rule_id,
  };
}

// ── Kid creates a request ──────────────────────────────────────────────────

export async function createRequestHandler(req: Request, env: Env): Promise<Response> {
  const ctx = await requireDeviceAuth(req, env);
  if (!ctx) return unauthorized();

  const body = await safeJson<CreateApprovalRequestBody>(req);
  if (!body || (body.targetKind !== 'app' && body.targetKind !== 'domain')) {
    return badRequest('targetKind must be "app" or "domain"');
  }
  if (typeof body.target !== 'string' || body.target.trim() === '') {
    return badRequest('target required');
  }
  if (!ALLOWED_MINUTES.has(Number(body.requestedMinutes))) {
    return badRequest('requestedMinutes must be 15, 30, or 60');
  }
  const target = body.target.trim();

  // Dedup: if there's already a pending row for the same target, return it.
  const existing = await findPendingApprovalForTarget(env.DB, ctx.deviceId, body.targetKind, target);
  if (existing) return json({ request: toApi(existing) });

  const row = await createApprovalRequest(
    env.DB, ctx.accountId, ctx.deviceId, body.targetKind, target, Number(body.requestedMinutes),
  );

  // Hydrate hostname so the notification title is human-readable.
  const dev = await env.DB.prepare('SELECT hostname FROM devices WHERE id = ?')
    .bind(ctx.deviceId).first<{ hostname: string | null }>();
  const host = dev?.hostname ?? 'A device';

  await createNotification(
    env.DB, ctx.accountId, 'approval_request',
    `${host} wants ${target} for ${row.requested_minutes}m`,
    `Approve or deny in the Family Inbox. Asks expire after an hour.`,
    { requestId: row.id },
  ).catch((err: unknown) => { console.warn('approval notification failed', err); });

  return json({ request: toApi(row) });
}

// ── Kid polls status ───────────────────────────────────────────────────────

export async function deviceGetRequestHandler(
  req: Request, env: Env, params: Record<string, string>,
): Promise<Response> {
  const ctx = await requireDeviceAuth(req, env);
  if (!ctx) return unauthorized();
  const row = await findApprovalRequestById(env.DB, params.id);
  if (!row || row.device_id !== ctx.deviceId) return notFound();
  return json({ request: toApi(row) });
}

// ── Parent hydrates one row ────────────────────────────────────────────────

export async function parentGetRequestHandler(
  req: Request, env: Env, params: Record<string, string>,
): Promise<Response> {
  const ctx = await requireAuth(req, env);
  if (!ctx) return unauthorized();
  const row = await findApprovalRequestById(env.DB, params.id);
  if (!row || row.account_id !== ctx.accountId) return notFound();
  return json({ request: toApi(row) });
}

// ── Parent approves ────────────────────────────────────────────────────────

export async function approveRequestHandler(
  req: Request, env: Env, params: Record<string, string>,
): Promise<Response> {
  const ctx = await requireAuth(req, env);
  if (!ctx) return unauthorized();

  const row = await findApprovalRequestById(env.DB, params.id);
  if (!row || row.account_id !== ctx.accountId) return notFound();
  if (row.status !== 'pending') return conflict(`already ${row.status}`);
  if (Date.parse(row.expires_at) <= Date.now()) return conflict('expired');

  // Create the time-limited rule first so we can stamp its id on the request.
  const expires = new Date(Date.now() + row.requested_minutes * 60 * 1000).toISOString();
  const rule = await createRule(
    env.DB, row.device_id, ctx.accountId, 'unblock_specific',
    row.target_kind === 'app' ? [row.target] : undefined,
    row.target_kind === 'domain' ? [row.target] : undefined,
    null, expires,
  );

  const ok = await markApprovalResolved(env.DB, row.id, ctx.accountId, 'approved', rule.id);
  if (!ok) {
    // Lost the race — another approve / expiry beat us. Roll back the rule.
    await env.DB.prepare('DELETE FROM lock_rules WHERE id = ?').bind(rule.id).run();
    return conflict('already resolved');
  }

  // Push the new rule to the device so it lifts the block within seconds.
  await notifyDevice(env, row.device_id, { type: 'rule_change', rule }).catch(() => { /* offline */ });

  return json({
    request: toApi({ ...row, status: 'approved', resolved_at: new Date().toISOString(), resolution_rule_id: rule.id }),
    rule,
  });
}

// ── Parent denies ──────────────────────────────────────────────────────────

export async function denyRequestHandler(
  req: Request, env: Env, params: Record<string, string>,
): Promise<Response> {
  const ctx = await requireAuth(req, env);
  if (!ctx) return unauthorized();

  const row = await findApprovalRequestById(env.DB, params.id);
  if (!row || row.account_id !== ctx.accountId) return notFound();
  if (row.status !== 'pending') return conflict(`already ${row.status}`);

  const ok = await markApprovalResolved(env.DB, row.id, ctx.accountId, 'denied', null);
  if (!ok) return conflict('already resolved');

  await notifyDevice(env, row.device_id, { type: 'request_resolved', requestId: row.id, status: 'denied' })
    .catch(() => { /* offline */ });

  return json({
    request: toApi({ ...row, status: 'denied', resolved_at: new Date().toISOString() }),
  });
}

// ── Local helper: device WS push (mirror of devices.ts pattern) ────────────

async function notifyDevice(env: Env, deviceId: string, message: object): Promise<void> {
  const id = env.DEVICE_CONN.idFromName(deviceId);
  const stub = env.DEVICE_CONN.get(id);
  await stub.fetch('http://device-conn/notify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
  });
}

// Re-mark `clientIp` as used (lint) — handlers above all accept the request
// for future audit additions even though we don't log here yet.
void clientIp;
