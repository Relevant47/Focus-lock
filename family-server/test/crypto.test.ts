import { describe, expect, it } from 'vitest';
import { hashPassword, signJwt, verifyJwt, verifyPassword } from '../src/crypto';

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('pbkdf2$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong password', hash)).toBe(false);
  });

  it('produces a unique salt per hash (same password → different hash)', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).not.toEqual(b);
    // ...but both still verify.
    expect(await verifyPassword('same-password', a)).toBe(true);
    expect(await verifyPassword('same-password', b)).toBe(true);
  });

  it('rejects malformed stored hashes without throwing', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'pbkdf2$100000$deadbeef')).toBe(false); // too few parts
    expect(await verifyPassword('x', 'bcrypt$10$salt$hash')).toBe(false);     // wrong scheme
  });
});

describe('JWT sign/verify', () => {
  const secret = 'unit-test-secret';

  it('round-trips a payload and preserves custom claims', async () => {
    const token = await signJwt({ sub: 'acc-1', kind: 'device', did: 'dev-9' }, secret, 60);
    const verified = await verifyJwt(token, secret);
    expect(verified).not.toBeNull();
    expect(verified!.payload.sub).toBe('acc-1');
    expect(verified!.payload.kind).toBe('device');
    expect(verified!.payload.did).toBe('dev-9');
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signJwt({ sub: 'acc-1' }, secret, 60);
    expect(await verifyJwt(token, 'other-secret')).toBeNull();
  });

  it('rejects a tampered token', async () => {
    const token = await signJwt({ sub: 'acc-1' }, secret, 60);
    const tampered = token.slice(0, -2) + (token.endsWith('a') ? 'bb' : 'aa');
    expect(await verifyJwt(tampered, secret)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const token = await signJwt({ sub: 'acc-1' }, secret, -1); // already expired
    expect(await verifyJwt(token, secret)).toBeNull();
  });

  it('rejects structurally invalid tokens', async () => {
    expect(await verifyJwt('only.two', secret)).toBeNull();
    expect(await verifyJwt('a.b.c.d', secret)).toBeNull();
  });
});
