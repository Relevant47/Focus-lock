import { describe, expect, it } from 'vitest';
import {
  LOGIN_POLICY, PAIR_POLICY,
  checkRateLimit, loginKey, pairCodeKey, pairIpKey, recordFailure, recordSuccess,
} from '../src/rateLimit';
import type { Env } from '../src/types';
import { FakeD1 } from './helpers';

function env(db: FakeD1): Env {
  return { DB: db as unknown as D1Database } as Env;
}

describe('rateLimit sliding window', () => {
  it('does not block before the limit and blocks once it is reached', async () => {
    const db = new FakeD1();
    const e = env(db);
    const key = loginKey('victim@example.com');

    // First (maxAttempts - 1) failures stay unblocked.
    for (let i = 0; i < LOGIN_POLICY.maxAttempts - 1; i++) {
      const r = await recordFailure(e, key, LOGIN_POLICY);
      expect(r.blocked).toBe(false);
    }
    // The attempt that reaches the limit blocks.
    const last = await recordFailure(e, key, LOGIN_POLICY);
    expect(last.blocked).toBe(true);
    expect(last.retryAfterSeconds).toBe(LOGIN_POLICY.blockSeconds);

    // A subsequent check reports the block too.
    const state = await checkRateLimit(e, key, LOGIN_POLICY);
    expect(state.blocked).toBe(true);
    expect(state.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('recordSuccess clears the counter', async () => {
    const db = new FakeD1();
    const e = env(db);
    const key = loginKey('user@example.com');

    await recordFailure(e, key, LOGIN_POLICY);
    await recordFailure(e, key, LOGIN_POLICY);
    await recordSuccess(e, key);

    const state = await checkRateLimit(e, key, LOGIN_POLICY);
    expect(state.blocked).toBe(false);
    // Counter is gone, so we can fail the full window again before blocking.
    for (let i = 0; i < LOGIN_POLICY.maxAttempts - 1; i++) {
      expect((await recordFailure(e, key, LOGIN_POLICY)).blocked).toBe(false);
    }
  });

  it('keys are independent (one blocked email does not block another)', async () => {
    const db = new FakeD1();
    const e = env(db);
    const a = loginKey('a@example.com');
    const b = loginKey('b@example.com');

    for (let i = 0; i < LOGIN_POLICY.maxAttempts; i++) await recordFailure(e, a, LOGIN_POLICY);
    expect((await checkRateLimit(e, a, LOGIN_POLICY)).blocked).toBe(true);
    expect((await checkRateLimit(e, b, LOGIN_POLICY)).blocked).toBe(false);
  });

  it('PAIR_POLICY blocks after its own threshold', async () => {
    const db = new FakeD1();
    const e = env(db);
    const key = pairIpKey('203.0.113.7');

    for (let i = 0; i < PAIR_POLICY.maxAttempts - 1; i++) {
      expect((await recordFailure(e, key, PAIR_POLICY)).blocked).toBe(false);
    }
    expect((await recordFailure(e, key, PAIR_POLICY)).blocked).toBe(true);
  });

  it('pair key helpers namespace ip vs code distinctly', () => {
    expect(pairIpKey('1.2.3.4')).toBe('pair-ip:1.2.3.4');
    expect(pairCodeKey('123456')).toBe('pair-code:123456');
  });
});
