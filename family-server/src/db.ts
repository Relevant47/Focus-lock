import type {
  AccountRow, AuditLogRow, DeviceRow, LockRule, LockRuleRow, NotificationRow, PairingCodeRow,
} from './types';

// ── accounts ───────────────────────────────────────────────────────────────

export async function findAccountByEmail(db: D1Database, email: string): Promise<AccountRow | null> {
  const row = await db.prepare('SELECT * FROM accounts WHERE email = ?')
    .bind(email.toLowerCase()).first();
  return row as AccountRow | null;
}

export async function findAccountById(db: D1Database, id: string): Promise<AccountRow | null> {
  const row = await db.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first();
  return row as AccountRow | null;
}

export async function createAccount(db: D1Database, email: string, passwordHash: string): Promise<AccountRow> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const lower = email.toLowerCase();
  await db.prepare('INSERT INTO accounts (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, lower, passwordHash, now).run();
  return { id, email: lower, password_hash: passwordHash, created_at: now, email_verified_at: null };
}

export async function updatePassword(db: D1Database, accountId: string, newHash: string): Promise<void> {
  await db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').bind(newHash, accountId).run();
}

/// Deletes the account and everything that hangs off it. FK cascade handles
/// devices, pairing_codes, lock_rules; audit_log has no FK so its account_id
/// rows are explicitly removed first to avoid orphans.
export async function deleteAccount(db: D1Database, accountId: string): Promise<void> {
  await db.prepare('DELETE FROM audit_log WHERE account_id = ?').bind(accountId).run();
  await db.prepare('DELETE FROM accounts WHERE id = ?').bind(accountId).run();
}

/// Fetches all rows belonging to an account in one shot, for the data-export
/// endpoint. Secrets (`password_hash`, `device_token_hash`) are stripped at the
/// HTTP layer — this helper returns raw rows so the caller controls the shape.
export async function loadAccountExport(db: D1Database, accountId: string): Promise<{
  account: AccountRow | null;
  devices: DeviceRow[];
  rules: LockRuleRow[];
  audit: AuditLogRow[];
}> {
  const account = await findAccountById(db, accountId);
  const devicesRes  = await db.prepare('SELECT * FROM devices WHERE account_id = ? ORDER BY paired_at DESC').bind(accountId).all();
  const rulesRes    = await db.prepare(
    `SELECT lr.* FROM lock_rules lr
     JOIN devices d ON d.id = lr.device_id
     WHERE d.account_id = ? ORDER BY lr.created_at DESC`,
  ).bind(accountId).all();
  const auditRes    = await db.prepare(
    'SELECT * FROM audit_log WHERE account_id = ? ORDER BY created_at DESC',
  ).bind(accountId).all();
  return {
    account,
    devices: (devicesRes.results ?? []) as unknown as DeviceRow[],
    rules:   (rulesRes.results   ?? []) as unknown as LockRuleRow[],
    audit:   (auditRes.results   ?? []) as unknown as AuditLogRow[],
  };
}

// ── reset-token single-use tracking ────────────────────────────────────────

/// Records that a reset-token `jti` has been consumed. Idempotent at the
/// PRIMARY KEY level — a second insert with the same jti throws, which is
/// how `isResetJtiUsed` callers detect a replay.
export async function markResetJtiUsed(
  db: D1Database,
  jti: string,
  expiresAtMs: number,
): Promise<void> {
  await db.prepare(
    'INSERT INTO used_reset_tokens (jti, consumed_at, expires_at) VALUES (?, ?, ?)',
  ).bind(jti, new Date().toISOString(), expiresAtMs).run();
}

export async function isResetJtiUsed(db: D1Database, jti: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 FROM used_reset_tokens WHERE jti = ?')
    .bind(jti).first();
  return row !== null;
}

// ── audit log ──────────────────────────────────────────────────────────────

export async function logAudit(
  db: D1Database,
  accountId: string | null,
  deviceId: string | null,
  event: string,
  payload: object | null,
  ip: string | null,
): Promise<void> {
  await db.prepare(
    'INSERT INTO audit_log (account_id, device_id, event, payload, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(
    accountId, deviceId, event,
    payload ? JSON.stringify(payload) : null,
    ip, new Date().toISOString(),
  ).run();
}

// ── devices ────────────────────────────────────────────────────────────────

export async function findDeviceById(db: D1Database, id: string): Promise<DeviceRow | null> {
  const row = await db.prepare('SELECT * FROM devices WHERE id = ?').bind(id).first();
  return row as DeviceRow | null;
}

export async function listDevicesForAccount(db: D1Database, accountId: string): Promise<DeviceRow[]> {
  const { results } = await db.prepare('SELECT * FROM devices WHERE account_id = ? ORDER BY paired_at DESC')
    .bind(accountId).all();
  return (results ?? []) as unknown as DeviceRow[];
}

export async function createDevice(
  db: D1Database,
  id: string,                     // pre-generated so the caller can use it in JWT + pair-consume
  accountId: string,
  hostname: string | null,
  os: 'windows' | 'macos',
  osVersion: string | null,
  ip: string | null,
  tokenHash: string,
): Promise<DeviceRow> {
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO devices (id, account_id, hostname, os, os_version, paired_at, last_seen_at, last_ip, device_token_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, accountId, hostname, os, osVersion, now, now, ip, tokenHash).run();
  return {
    id, account_id: accountId, hostname, os, os_version: osVersion,
    paired_at: now, last_seen_at: now, last_ip: ip, device_token_hash: tokenHash,
  };
}

export async function deleteDevice(db: D1Database, deviceId: string, accountId: string): Promise<boolean> {
  const res = await db.prepare('DELETE FROM devices WHERE id = ? AND account_id = ?')
    .bind(deviceId, accountId).run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function touchDeviceLastSeen(db: D1Database, deviceId: string, ip: string | null): Promise<void> {
  await db.prepare('UPDATE devices SET last_seen_at = ?, last_ip = ? WHERE id = ?')
    .bind(new Date().toISOString(), ip, deviceId).run();
}

// ── pairing codes ──────────────────────────────────────────────────────────

const PAIR_CODE_LENGTH = 6;
const PAIR_CODE_TTL_SECONDS = 10 * 60;

export async function createPairingCode(db: D1Database, accountId: string): Promise<PairingCodeRow> {
  // 6-digit numeric. Retry on the (rare) collision with an active code.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = String(Math.floor(Math.random() * 10 ** PAIR_CODE_LENGTH)).padStart(PAIR_CODE_LENGTH, '0');
    const now = Date.now();
    const created = new Date(now).toISOString();
    const expires = new Date(now + PAIR_CODE_TTL_SECONDS * 1000).toISOString();
    try {
      await db.prepare(
        'INSERT INTO pairing_codes (code, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      ).bind(code, accountId, created, expires).run();
      return { code, account_id: accountId, created_at: created, expires_at: expires, consumed_at: null, consumed_by_device_id: null };
    } catch {
      // PRIMARY KEY collision — try a different code.
    }
  }
  throw new Error('failed to allocate pairing code after retries');
}

export async function consumePairingCode(
  db: D1Database,
  code: string,
  consumingDeviceId: string,
): Promise<PairingCodeRow | null> {
  // Atomic-ish: select valid + update consumed in a single batch.
  // D1 doesn't have transactions over JS values, but UPDATE...WHERE consumed_at IS NULL
  // ensures only one consumer wins.
  const row = await db.prepare(
    `SELECT * FROM pairing_codes
     WHERE code = ? AND consumed_at IS NULL AND expires_at > ?`,
  ).bind(code, new Date().toISOString()).first() as PairingCodeRow | null;
  if (!row) return null;

  const now = new Date().toISOString();
  const res = await db.prepare(
    'UPDATE pairing_codes SET consumed_at = ?, consumed_by_device_id = ? WHERE code = ? AND consumed_at IS NULL',
  ).bind(now, consumingDeviceId, code).run();
  if ((res.meta?.changes ?? 0) === 0) return null;  // Lost the race
  return { ...row, consumed_at: now, consumed_by_device_id: consumingDeviceId };
}

export const PAIR_CODE_TTL = PAIR_CODE_TTL_SECONDS;

// ── lock rules ─────────────────────────────────────────────────────────────

export async function createRule(
  db: D1Database,
  deviceId: string,
  createdByAccountId: string,
  kind: 'block_now' | 'schedule' | 'unblock_all',
  targetApps: string[] | undefined,
  targetDomains: string[] | undefined,
  scheduleCron: string | null,
): Promise<LockRule> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const apps = targetApps && targetApps.length ? JSON.stringify(targetApps) : null;
  const domains = targetDomains && targetDomains.length ? JSON.stringify(targetDomains) : null;
  await db.prepare(
    `INSERT INTO lock_rules (id, device_id, kind, target_apps, target_domains, schedule_cron, active, created_at, created_by_account_id)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).bind(id, deviceId, kind, apps, domains, scheduleCron, now, createdByAccountId).run();
  return rowToRule({
    id, device_id: deviceId, kind, target_apps: apps, target_domains: domains,
    schedule_cron: scheduleCron, active: 1, created_at: now, created_by_account_id: createdByAccountId,
  });
}

export async function listActiveRulesForDevice(db: D1Database, deviceId: string): Promise<LockRule[]> {
  const { results } = await db.prepare(
    'SELECT * FROM lock_rules WHERE device_id = ? AND active = 1 ORDER BY created_at DESC',
  ).bind(deviceId).all();
  return ((results ?? []) as unknown as LockRuleRow[]).map(rowToRule);
}

export async function deleteRule(db: D1Database, ruleId: string, deviceId: string): Promise<boolean> {
  const res = await db.prepare('UPDATE lock_rules SET active = 0 WHERE id = ? AND device_id = ?')
    .bind(ruleId, deviceId).run();
  return (res.meta?.changes ?? 0) > 0;
}

function rowToRule(r: LockRuleRow): LockRule {
  return {
    id: r.id,
    deviceId: r.device_id,
    kind: r.kind,
    targetApps:    r.target_apps    ? safeParseArr(r.target_apps)    : [],
    targetDomains: r.target_domains ? safeParseArr(r.target_domains) : [],
    scheduleCron: r.schedule_cron,
    active: r.active === 1,
    createdAt: r.created_at,
  };
}

function safeParseArr(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
  } catch { return []; }
}

// ── notifications (Family Inbox) ───────────────────────────────────────────

export async function createNotification(
  db: D1Database,
  accountId: string,
  kind: 'weekly_digest' | 'device_paired',
  title: string,
  body: string,
  payload: unknown,
): Promise<NotificationRow> {
  const now = new Date().toISOString();
  const payloadJson = payload == null ? null : JSON.stringify(payload);
  const res = await db.prepare(
    `INSERT INTO notifications (account_id, kind, title, body, payload, read_at, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)
     RETURNING *`,
  ).bind(accountId, kind, title, body, payloadJson, now).first();
  return res as unknown as NotificationRow;
}

export async function listNotificationsForAccount(
  db: D1Database,
  accountId: string,
  limit = 50,
): Promise<NotificationRow[]> {
  // Unread first (NULL sorts last in SQLite ASC, so we use IS NULL DESC),
  // then newest first within each group.
  const res = await db.prepare(
    `SELECT * FROM notifications
     WHERE account_id = ?
     ORDER BY (read_at IS NULL) DESC, created_at DESC
     LIMIT ?`,
  ).bind(accountId, limit).all();
  return (res.results ?? []) as unknown as NotificationRow[];
}

export async function countUnreadNotifications(
  db: D1Database,
  accountId: string,
): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM notifications
     WHERE account_id = ? AND read_at IS NULL`,
  ).bind(accountId).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function markNotificationRead(
  db: D1Database,
  notificationId: number,
  accountId: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const res = await db.prepare(
    `UPDATE notifications SET read_at = ?
     WHERE id = ? AND account_id = ? AND read_at IS NULL`,
  ).bind(now, notificationId, accountId).run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function markAllNotificationsRead(
  db: D1Database,
  accountId: string,
): Promise<number> {
  const now = new Date().toISOString();
  const res = await db.prepare(
    `UPDATE notifications SET read_at = ?
     WHERE account_id = ? AND read_at IS NULL`,
  ).bind(now, accountId).run();
  return res.meta?.changes ?? 0;
}
