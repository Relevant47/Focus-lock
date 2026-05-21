import { verifyJwt } from './crypto';
import type { AuthContext, DeviceAuthContext, Env } from './types';

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export function badRequest(msg: string): Response  { return json({ error: msg },           400); }
export function unauthorized(msg = 'unauthorized'): Response { return json({ error: msg }, 401); }
export function forbidden(msg = 'forbidden'): Response       { return json({ error: msg }, 403); }
export function notFound(): Response               { return json({ error: 'not found' },   404); }
export function conflict(msg: string): Response    { return json({ error: msg },           409); }
export function gone(msg: string): Response        { return json({ error: msg },           410); }
export function serverError(): Response            { return json({ error: 'internal error' }, 500); }

export async function safeJson<T = unknown>(req: Request): Promise<T | null> {
  try { return await req.json() as T; } catch { return null; }
}

export function clientIp(req: Request): string | null {
  return req.headers.get('cf-connecting-ip') ?? null;
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

export async function requireAuth(req: Request, env: Env): Promise<AuthContext | null> {
  const h = req.headers.get('authorization');
  if (!h || !h.startsWith('Bearer ')) return null;
  const token = h.slice(7);
  const verified = await verifyJwt(token, env.JWT_SECRET);
  // Reset tokens and device tokens cannot be used as parent sessions.
  if (!verified || verified.payload.kind === 'reset' || verified.payload.kind === 'device') return null;
  if (typeof verified.payload.sub !== 'string') return null;
  return { accountId: verified.payload.sub };
}

export async function requireDeviceAuth(req: Request, env: Env): Promise<DeviceAuthContext | null> {
  const h = req.headers.get('authorization');
  if (!h || !h.startsWith('Bearer ')) return null;
  const token = h.slice(7);
  const verified = await verifyJwt(token, env.JWT_SECRET);
  if (!verified || verified.payload.kind !== 'device') return null;
  const did = verified.payload.did;
  const sub = verified.payload.sub;
  if (typeof did !== 'string' || typeof sub !== 'string') return null;
  // Revocation check: the device row must still exist for this account.
  const row = await env.DB.prepare('SELECT id FROM devices WHERE id = ? AND account_id = ?')
    .bind(did, sub).first();
  if (!row) return null;
  return { deviceId: did, accountId: sub };
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}
