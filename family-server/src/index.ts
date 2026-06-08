import { deleteAccountHandler, exportAccount } from './account';
import { login, refresh, resetConfirm, resetRequest, signup } from './auth';
import {
  createRuleHandler, deleteDeviceHandler, deleteRuleHandler,
  listDevices, listMyRulesHandler, listRulesHandler,
} from './devices';
import { listNotificationsHandler, markAllReadHandler, markReadHandler } from './notifications';
import { pairCreate, pairRedeem } from './pairing';
import { add, dispatch } from './router';
import type { Env } from './types';
import { badRequest, json, requireDeviceAuth, unauthorized } from './utils';

export { DeviceConnection } from './do';

// ── Health ─────────────────────────────────────────────────────────────────
add('GET',  '/healthz', async () => json({ ok: true, version: '0.2.0' }));

// ── Auth (Phase 2.1) ───────────────────────────────────────────────────────
add('POST', '/api/v1/auth/signup',        signup);
add('POST', '/api/v1/auth/login',         login);
add('POST', '/api/v1/auth/refresh',       refresh);
add('POST', '/api/v1/auth/reset-request', resetRequest);
add('POST', '/api/v1/auth/reset-confirm', resetConfirm);

// ── Account data portability (Phase 2.7) ───────────────────────────────────
add('GET',    '/api/v1/account/export', exportAccount);
add('DELETE', '/api/v1/account',        deleteAccountHandler);

// ── Pairing (Phase 2.2) ────────────────────────────────────────────────────
add('POST', '/api/v1/family/pair/create', pairCreate);
add('POST', '/api/v1/family/pair/redeem', pairRedeem);

// ── Devices (parent) ───────────────────────────────────────────────────────
add('GET',    '/api/v1/family/devices',                listDevices);
add('DELETE', '/api/v1/family/devices/:id',            deleteDeviceHandler);
add('POST',   '/api/v1/family/devices/:id/rules',      createRuleHandler);
add('GET',    '/api/v1/family/devices/:id/rules',      listRulesHandler);
add('DELETE', '/api/v1/family/devices/:id/rules/:ruleId', deleteRuleHandler);

// ── Device-side (child daemon) ─────────────────────────────────────────────
add('GET',  '/api/v1/device/rules', listMyRulesHandler);
add('GET',  '/api/v1/device/ws',    deviceWsUpgrade);

async function deviceWsUpgrade(req: Request, env: Env): Promise<Response> {
  const ctx = await requireDeviceAuth(req, env);
  if (!ctx) return unauthorized();
  if (req.headers.get('upgrade') !== 'websocket') return badRequest('expected websocket upgrade');

  const id = env.DEVICE_CONN.idFromName(ctx.deviceId);
  const stub = env.DEVICE_CONN.get(id);

  const upstream = new URL(req.url);
  upstream.pathname = '/connect';
  upstream.searchParams.set('did', ctx.deviceId);
  return stub.fetch(new Request(upstream.toString(), req));
}

// ── Notifications (Phase 3.1 — Family Inbox) ───────────────────────────────
add('GET',  '/api/v1/notifications',              listNotificationsHandler);
add('POST', '/api/v1/notifications/:id/read',     markReadHandler);
add('POST', '/api/v1/notifications/read-all',     markAllReadHandler);

// ── CORS ───────────────────────────────────────────────────────────────────
// The Tauri desktop app fetches this Worker from a `tauri://localhost` (mac)
// or `https://tauri.localhost` (win) origin. WebKit treats POSTs with a
// content-type: application/json body as non-simple and requires preflight,
// so without these headers every signup/login/reset call from the app fails
// with "Load failed" before the Worker ever sees the request. We accept any
// origin because the API has no cookie-based session — all auth is JWT in
// the Authorization header, so CSRF via origin spoofing doesn't apply.
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
};

// ── Entry ──────────────────────────────────────────────────────────────────
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const res = await dispatch(req, env);
    // WebSocket upgrade responses carry a `webSocket` prop that doesn't
    // survive `new Response(...)` reconstruction — leave them untouched.
    if (res.status === 101) return res;
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
} satisfies ExportedHandler<Env>;
