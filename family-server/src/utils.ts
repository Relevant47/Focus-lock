import { verifyJwt } from './crypto';
import type { AuthContext, Env } from './types';

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export function badRequest(msg: string): Response  { return json({ error: msg },           400); }
export function unauthorized(msg = 'unauthorized'): Response { return json({ error: msg }, 401); }
export function conflict(msg: string): Response    { return json({ error: msg },           409); }
export function notFound(): Response               { return json({ error: 'not found' },   404); }
export function serverError(): Response            { return json({ error: 'internal error' }, 500); }

export async function safeJson<T = unknown>(req: Request): Promise<T | null> {
  try { return await req.json() as T; } catch { return null; }
}

export function clientIp(req: Request): string | null {
  return req.headers.get('cf-connecting-ip') ?? null;
}

// Permissive but bounded — full RFC 5322 is overkill and rejects valid addresses.
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

export async function requireAuth(req: Request, env: Env): Promise<AuthContext | null> {
  const h = req.headers.get('authorization');
  if (!h || !h.startsWith('Bearer ')) return null;
  const token = h.slice(7);
  const verified = await verifyJwt(token, env.JWT_SECRET);
  // A `kind: 'reset'` token can only be used on /reset-confirm, never as a session.
  if (!verified || verified.payload.kind === 'reset') return null;
  if (typeof verified.payload.sub !== 'string') return null;
  return { accountId: verified.payload.sub };
}
