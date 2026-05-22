import { hashPassword, signJwt, verifyJwt, verifyPassword } from './crypto';
import { createAccount, findAccountByEmail, logAudit, updatePassword } from './db';
import { sendResetEmail } from './email';
import type { Env } from './types';
import {
  badRequest,
  clientIp,
  conflict,
  isValidEmail,
  json,
  requireAuth,
  safeJson,
  unauthorized,
} from './utils';

const SESSION_TTL_SECONDS = 30 * 24 * 3600;        // 30 days
const RESET_TOKEN_TTL_SECONDS = 60 * 60;           // 1 hour to redeem a reset link
const MIN_PASSWORD_LENGTH = 8;

interface AuthBody { email?: unknown; password?: unknown }
interface ResetRequestBody  { email?: unknown }
interface ResetConfirmBody  { token?: unknown; newPassword?: unknown }

async function issueSession(env: Env, accountId: string): Promise<Response> {
  const token = await signJwt({ sub: accountId }, env.JWT_SECRET, SESSION_TTL_SECONDS);
  return json({ token, accountId, expiresIn: SESSION_TTL_SECONDS });
}

export async function signup(req: Request, env: Env): Promise<Response> {
  const body = await safeJson<AuthBody>(req);
  if (!body || typeof body.email !== 'string' || typeof body.password !== 'string') {
    return badRequest('email and password required');
  }
  const email = body.email.trim().toLowerCase();
  const password = body.password;
  if (!isValidEmail(email))                return badRequest('invalid email');
  if (password.length < MIN_PASSWORD_LENGTH) return badRequest(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);

  if (await findAccountByEmail(env.DB, email)) {
    return conflict('email already registered');
  }
  const hash = await hashPassword(password);
  const account = await createAccount(env.DB, email, hash);
  await logAudit(env.DB, account.id, null, 'signup', { email }, clientIp(req));
  return issueSession(env, account.id);
}

export async function login(req: Request, env: Env): Promise<Response> {
  const body = await safeJson<AuthBody>(req);
  if (!body || typeof body.email !== 'string' || typeof body.password !== 'string') {
    return badRequest('email and password required');
  }
  const email = body.email.trim().toLowerCase();
  const account = await findAccountByEmail(env.DB, email);

  // Hash either way to make the no-such-account branch take similar time to wrong-password.
  if (!account) {
    await hashPassword(body.password);
    return unauthorized('invalid credentials');
  }
  const ok = await verifyPassword(body.password, account.password_hash);
  if (!ok) {
    await logAudit(env.DB, account.id, null, 'login_failed', null, clientIp(req));
    return unauthorized('invalid credentials');
  }
  await logAudit(env.DB, account.id, null, 'login', null, clientIp(req));
  return issueSession(env, account.id);
}

export async function refresh(req: Request, env: Env): Promise<Response> {
  const ctx = await requireAuth(req, env);
  if (!ctx) return unauthorized();
  return issueSession(env, ctx.accountId);
}

export async function resetRequest(req: Request, env: Env): Promise<Response> {
  const body = await safeJson<ResetRequestBody>(req);
  if (!body || typeof body.email !== 'string') return badRequest('email required');
  const email = body.email.trim().toLowerCase();
  const account = await findAccountByEmail(env.DB, email);
  if (account) {
    const resetToken = await signJwt({ sub: account.id, kind: 'reset' }, env.JWT_SECRET, RESET_TOKEN_TTL_SECONDS);
    await logAudit(env.DB, account.id, null, 'password_reset_requested', null, clientIp(req));
    await sendResetEmail(env, email, resetToken);
  }
  // Same response regardless of whether the email exists, to prevent enumeration.
  return json({ message: 'If that email is registered, a reset link has been sent.' });
}

export async function resetConfirm(req: Request, env: Env): Promise<Response> {
  const body = await safeJson<ResetConfirmBody>(req);
  if (!body || typeof body.token !== 'string' || typeof body.newPassword !== 'string') {
    return badRequest('token and newPassword required');
  }
  if (body.newPassword.length < MIN_PASSWORD_LENGTH) {
    return badRequest(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const verified = await verifyJwt(body.token, env.JWT_SECRET);
  if (!verified || verified.payload.kind !== 'reset' || typeof verified.payload.sub !== 'string') {
    return unauthorized('invalid or expired reset token');
  }
  const newHash = await hashPassword(body.newPassword);
  await updatePassword(env.DB, verified.payload.sub, newHash);
  await logAudit(env.DB, verified.payload.sub, null, 'password_reset_completed', null, clientIp(req));
  return issueSession(env, verified.payload.sub);
}
