import type { AccountRow } from './types';

export async function findAccountByEmail(db: D1Database, email: string): Promise<AccountRow | null> {
  const row = await db.prepare('SELECT * FROM accounts WHERE email = ?')
    .bind(email.toLowerCase())
    .first();
  return row as AccountRow | null;
}

export async function findAccountById(db: D1Database, id: string): Promise<AccountRow | null> {
  const row = await db.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first();
  return row as AccountRow | null;
}

export async function createAccount(
  db: D1Database,
  email: string,
  passwordHash: string,
): Promise<AccountRow> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const lower = email.toLowerCase();
  await db.prepare(
    'INSERT INTO accounts (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)',
  ).bind(id, lower, passwordHash, now).run();
  return { id, email: lower, password_hash: passwordHash, created_at: now, email_verified_at: null };
}

export async function updatePassword(
  db: D1Database,
  accountId: string,
  newHash: string,
): Promise<void> {
  await db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?')
    .bind(newHash, accountId)
    .run();
}

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
    accountId,
    deviceId,
    event,
    payload ? JSON.stringify(payload) : null,
    ip,
    new Date().toISOString(),
  ).run();
}
