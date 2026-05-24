import { describe, expect, it } from 'vitest';
import { pairRedeem } from '../src/pairing';
import { PAIR_POLICY } from '../src/rateLimit';
import type { Env } from '../src/types';
import { FakeD1, jsonRequest } from './helpers';

function env(db: FakeD1): Env {
  return {
    DB: db as unknown as D1Database,
    JWT_SECRET: 'test-secret',
    DEVICE_CONN: {} as unknown as DurableObjectNamespace,
  } as Env;
}

const URL = 'https://worker.test/api/v1/family/pair/redeem';

describe('pairRedeem rate limiting', () => {
  it('400s on a malformed code before touching the rate limiter', async () => {
    const db = new FakeD1();
    const res = await pairRedeem(jsonRequest(URL, { code: 'abc', os: 'windows' }), env(db));
    expect(res.status).toBe(400);
    expect(db.rateLimits.size).toBe(0);
  });

  it('returns 410 (gone) for an invalid code until the per-IP limit is hit, then 429', async () => {
    const db = new FakeD1();             // no valid pairing row → every redeem misses
    const e = env(db);
    const ip = '198.51.100.22';

    // Each miss before the cap should be a 410 gone.
    for (let i = 0; i < PAIR_POLICY.maxAttempts - 1; i++) {
      const res = await pairRedeem(jsonRequest(URL, { code: '000000', os: 'windows' }, ip), e);
      expect(res.status).toBe(410);
    }
    // The miss that reaches the cap returns 429 with a Retry-After header.
    const blocked = await pairRedeem(jsonRequest(URL, { code: '000000', os: 'windows' }, ip), e);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    const body = await blocked.json() as { retryAfterSeconds: number };
    expect(body.retryAfterSeconds).toBeGreaterThan(0);

    // And a fresh attempt while blocked is still 429 (not 410).
    const stillBlocked = await pairRedeem(jsonRequest(URL, { code: '000000', os: 'windows' }, ip), e);
    expect(stillBlocked.status).toBe(429);
  });

  it('blocks a distributed guess at one code across rotating IPs via the per-code key', async () => {
    const db = new FakeD1();
    const e = env(db);

    // Same code, a different IP every time → the per-IP key never caps, but the
    // per-code key should, proving the second guard works.
    let sawBlocked = false;
    for (let i = 0; i < PAIR_POLICY.maxAttempts + 2; i++) {
      const ip = `203.0.113.${i + 1}`;
      const res = await pairRedeem(jsonRequest(URL, { code: '424242', os: 'macos' }, ip), e);
      if (res.status === 429) { sawBlocked = true; break; }
      expect(res.status).toBe(410);
    }
    expect(sawBlocked).toBe(true);
  });
});
