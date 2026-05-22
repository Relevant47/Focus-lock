import { deleteAccountHandler, exportAccount } from './account';
import { login, refresh, resetConfirm, resetRequest, signup } from './auth';
import {
  createRuleHandler, deleteDeviceHandler, deleteRuleHandler,
  listDevices, listMyRulesHandler, listRulesHandler,
} from './devices';
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

// ── Entry ──────────────────────────────────────────────────────────────────
export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return dispatch(req, env);
  },
} satisfies ExportedHandler<Env>;
