import { login, refresh, resetConfirm, resetRequest, signup } from './auth';
import type { Env } from './types';
import { json, notFound, serverError } from './utils';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname}`;

    try {
      switch (route) {
        case 'POST /api/v1/auth/signup':        return await signup(req, env);
        case 'POST /api/v1/auth/login':         return await login(req, env);
        case 'POST /api/v1/auth/refresh':       return await refresh(req, env);
        case 'POST /api/v1/auth/reset-request': return await resetRequest(req, env);
        case 'POST /api/v1/auth/reset-confirm': return await resetConfirm(req, env);
        case 'GET /healthz':                    return json({ ok: true, version: '0.1.0' });
        default:                                return notFound();
      }
    } catch (err) {
      console.error('worker error', err);
      return serverError();
    }
  },
} satisfies ExportedHandler<Env>;
