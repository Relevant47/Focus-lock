// Phase 2.7 — data portability.
//
// Two endpoints, both authenticated as the parent (parent JWT):
//   GET    /api/v1/account/export   → JSON dump of everything owned by this
//                                     account, minus secrets (password_hash,
//                                     device_token_hash). Schema-versioned so
//                                     a future import tool has a stable shape.
//   DELETE /api/v1/account          → Wipes the account and cascades to its
//                                     devices, rules, pairing codes, audit
//                                     rows. Requires password re-entry — even
//                                     with a stolen JWT, an attacker can't
//                                     nuke an account without the password.
//
// Account-deleted audit row is written with account_id=NULL so it survives
// the cascade and we still have a forensic trail in worker logs / D1.

import { verifyPassword } from './crypto';
import { deleteAccount, findAccountById, loadAccountExport, logAudit } from './db';
import type { AuditLogRow, DeviceRow, Env, LockRuleRow } from './types';
import {
  badRequest, clientIp, json, requireAuth, safeJson, unauthorized,
} from './utils';

const EXPORT_SCHEMA_VERSION = '1.0';

interface DeleteAccountBody { password?: unknown }

export async function exportAccount(req: Request, env: Env): Promise<Response> {
  const ctx = await requireAuth(req, env);
  if (!ctx) return unauthorized();

  const { account, devices, rules, audit } = await loadAccountExport(env.DB, ctx.accountId);
  if (!account) return unauthorized();  // JWT valid but account gone — treat as logged-out

  const body = {
    schema_version: EXPORT_SCHEMA_VERSION,
    exported_at: new Date().toISOString(),
    account: {
      id: account.id,
      email: account.email,
      created_at: account.created_at,
      email_verified_at: account.email_verified_at,
    },
    devices: devices.map(stripDevice),
    lock_rules: rules.map(stripRule),
    audit_log: audit.map(stripAudit),
  };

  await logAudit(env.DB, ctx.accountId, null, 'account_data_exported',
    { deviceCount: devices.length, ruleCount: rules.length, auditCount: audit.length },
    clientIp(req));

  return json(body);
}

export async function deleteAccountHandler(req: Request, env: Env): Promise<Response> {
  const ctx = await requireAuth(req, env);
  if (!ctx) return unauthorized();

  const body = await safeJson<DeleteAccountBody>(req);
  if (!body || typeof body.password !== 'string') {
    return badRequest('password required');
  }

  const account = await findAccountById(env.DB, ctx.accountId);
  if (!account) return unauthorized();
  const ok = await verifyPassword(body.password, account.password_hash);
  if (!ok) {
    await logAudit(env.DB, ctx.accountId, null, 'account_delete_failed', null, clientIp(req));
    return unauthorized('invalid password');
  }

  // Write the forensic trail with account_id=NULL so the row survives the
  // cascade — payload carries the (now-tombstone) email for ops lookup.
  await logAudit(env.DB, null, null, 'account_deleted',
    { accountId: ctx.accountId, email: account.email },
    clientIp(req));

  await deleteAccount(env.DB, ctx.accountId);
  return json({ ok: true });
}

// ── Row → API shape mappers (strip secrets) ───────────────────────────────

function stripDevice(d: DeviceRow) {
  return {
    id: d.id,
    hostname: d.hostname,
    os: d.os,
    os_version: d.os_version,
    paired_at: d.paired_at,
    last_seen_at: d.last_seen_at,
    last_ip: d.last_ip,
  };
}

function stripRule(r: LockRuleRow) {
  return {
    id: r.id,
    device_id: r.device_id,
    kind: r.kind,
    target_apps: r.target_apps ? safeParse(r.target_apps) : [],
    target_domains: r.target_domains ? safeParse(r.target_domains) : [],
    schedule_cron: r.schedule_cron,
    active: r.active === 1,
    created_at: r.created_at,
    expires_at: r.expires_at,
  };
}

function stripAudit(a: AuditLogRow) {
  // IP omitted on purpose — the parent's own IP history isn't useful to them
  // in an export, and shipping it makes a shared export file an accidental
  // location-history leak.
  return {
    id: a.id,
    device_id: a.device_id,
    event: a.event,
    payload: a.payload ? safeParse(a.payload) : null,
    created_at: a.created_at,
  };
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
