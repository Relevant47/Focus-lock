import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
// The Vercel function under test (imported directly; lives outside src/, excluded from tsc).
import handler from '../../../api/survey/submit';

type Captured = { code: number; body: any; headers: Record<string, string> };

function mockReqRes(method: string, body: unknown) {
  const req = { method, body, headers: { 'x-forwarded-for': '203.0.113.5' } };
  const out: Captured = { code: 0, body: undefined, headers: {} };
  const res: any = {
    setHeader: (k: string, v: string) => { out.headers[k] = v; },
    status: (c: number) => { out.code = c; return res; },
    json: (b: unknown) => { out.body = b; },
    end: () => {},
  };
  return { req, res, out };
}

/** Build a fetch stub. `recentRows` controls the rate-limit check result. */
function stubFetch(recentRows: unknown[], insertOk = true) {
  return vi.fn(async (url: string, init?: any) => {
    if (url.includes('survey_submit_ratelimit') && (!init || init.method !== 'POST')) {
      return { ok: true, json: async () => recentRows, headers: { get: () => null } };
    }
    if (url.includes('survey_responses')) {
      return { ok: insertOk, json: async () => [{ id: '11111111-1111-1111-1111-111111111111' }], headers: { get: () => null } };
    }
    // rate-limit marker insert
    return { ok: true, json: async () => ({}), headers: { get: () => null } };
  });
}

describe('POST /api/survey/submit', () => {
  beforeEach(() => { vi.stubGlobal('fetch', stubFetch([])); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('rejects non-POST', async () => {
    const { req, res, out } = mockReqRes('GET', {});
    await handler(req as any, res);
    expect(out.code).toBe(405);
  });

  it('rejects an invalid payload with 400', async () => {
    const { req, res, out } = mockReqRes('POST', { age_range: 'nope' });
    await handler(req as any, res);
    expect(out.code).toBe(400);
  });

  it('stores a valid submission and returns the new id', async () => {
    const { req, res, out } = mockReqRes('POST', { nps: 8, primary_os: 'macos' });
    await handler(req as any, res);
    expect(out.code).toBe(200);
    expect(out.body.success).toBe(true);
    expect(out.body.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns 429 when the IP already submitted within the hour', async () => {
    vi.stubGlobal('fetch', stubFetch([{ created_at: new Date().toISOString() }]));
    const { req, res, out } = mockReqRes('POST', { nps: 8 });
    await handler(req as any, res);
    expect(out.code).toBe(429);
    expect(out.headers['Retry-After']).toBe('3600');
  });
});
