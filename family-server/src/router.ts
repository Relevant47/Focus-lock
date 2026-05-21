import type { Env } from './types';
import { notFound, serverError } from './utils';

type Handler = (req: Request, env: Env, params: Record<string, string>) => Promise<Response>;
interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler }

const routes: Route[] = [];

export function add(method: string, path: string, handler: Handler): void {
  const keys: string[] = [];
  const re = path.replace(/:([a-zA-Z]+)/g, (_, k: string) => { keys.push(k); return '([^/]+)'; });
  routes.push({ method, pattern: new RegExp(`^${re}$`), keys, handler });
}

export async function dispatch(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.pattern.exec(url.pathname);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    try {
      return await r.handler(req, env, params);
    } catch (err) {
      console.error('handler error', url.pathname, err);
      return serverError();
    }
  }
  return notFound();
}
