// Phase 3.1 — Family Inbox HTTP handlers.
//
// All three endpoints are parent-only (parent JWT, no device tokens).
//   GET  /api/v1/notifications        → { notifications: Notification[], unreadCount: number }
//   POST /api/v1/notifications/:id/read
//   POST /api/v1/notifications/read-all

import {
  countUnreadNotifications, listNotificationsForAccount,
  markAllNotificationsRead, markNotificationRead,
} from './db';
import type { Env, Notification, NotificationRow } from './types';
import { badRequest, json, notFound, requireAuth, unauthorized } from './utils';

function toApi(row: NotificationRow): Notification {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    payload: row.payload ? safeParse(row.payload) : null,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

export async function listNotificationsHandler(req: Request, env: Env): Promise<Response> {
  const ctx = await requireAuth(req, env);
  if (!ctx) return unauthorized();
  const rows = await listNotificationsForAccount(env.DB, ctx.accountId);
  const unreadCount = await countUnreadNotifications(env.DB, ctx.accountId);
  return json({ notifications: rows.map(toApi), unreadCount });
}

export async function markReadHandler(
  req: Request, env: Env, params: Record<string, string>,
): Promise<Response> {
  const ctx = await requireAuth(req, env);
  if (!ctx) return unauthorized();
  const id = Number(params.id);
  if (!Number.isFinite(id)) return badRequest('id must be a number');
  const ok = await markNotificationRead(env.DB, id, ctx.accountId);
  if (!ok) return notFound();
  return json({ ok: true });
}

export async function markAllReadHandler(req: Request, env: Env): Promise<Response> {
  const ctx = await requireAuth(req, env);
  if (!ctx) return unauthorized();
  const changed = await markAllNotificationsRead(env.DB, ctx.accountId);
  return json({ ok: true, marked: changed });
}
