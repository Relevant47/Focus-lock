// Minimal in-memory fakes for unit-testing the Worker's pure logic without a
// real D1 / miniflare. We only model what the code under test actually
// queries:
//   • the `auth_rate_limits` table (used by rateLimit.ts), and
//   • a SELECT on `pairing_codes` that, by default, finds no valid code
//     (so the pair/redeem failure path — the one that drives the rate
//     limiter — is exercised without needing the rest of the schema).
//
// This is deliberately not a general SQL engine. If a test needs another
// table, model it here explicitly rather than reaching for a parser.

interface RateLimitRow {
  key: string;
  attempts: number;
  window_start: string;
  blocked_until: string | null;
}

export interface FakeDbOptions {
  /// When set, the fake pairing_codes SELECT returns this row (a "valid code").
  /// Default: null → every redeem misses, which is what the rate-limit tests want.
  validPairingRow?: Record<string, unknown> | null;
}

class FakeStatement {
  constructor(
    private readonly db: FakeD1,
    private readonly sql: string,
    private readonly args: unknown[] = [],
  ) {}

  bind(...args: unknown[]): FakeStatement {
    return new FakeStatement(this.db, this.sql, args);
  }

  async first(): Promise<unknown | null> {
    const s = this.sql;
    if (s.includes('FROM auth_rate_limits') && s.trim().startsWith('SELECT')) {
      const key = this.args[0] as string;
      return this.db.rateLimits.get(key) ?? null;
    }
    if (s.includes('FROM pairing_codes') && s.trim().startsWith('SELECT')) {
      return this.db.validPairingRow;
    }
    return null;
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const s = this.sql;

    // rateLimit.ts upserts (two shapes — blocked and not-blocked).
    if (s.includes('INTO auth_rate_limits')) {
      const [key, attempts, windowStart, blockedUntil] = this.args as [
        string, number, string, string | null,
      ];
      this.db.rateLimits.set(key, {
        key,
        attempts,
        window_start: windowStart,
        // The NULL-blocked variant only binds 3 args; blockedUntil is undefined.
        blocked_until: blockedUntil === undefined ? null : blockedUntil,
      });
      return { meta: { changes: 1 } };
    }

    if (s.includes('DELETE FROM auth_rate_limits')) {
      const key = this.args[0] as string;
      const had = this.db.rateLimits.delete(key);
      return { meta: { changes: had ? 1 : 0 } };
    }

    // UPDATE pairing_codes (consume): on the miss path there's no valid row, so
    // the handler never calls this; model it as a no-op for completeness.
    return { meta: { changes: 0 } };
  }

  async all(): Promise<{ results: unknown[] }> {
    return { results: [] };
  }
}

export class FakeD1 {
  readonly rateLimits = new Map<string, RateLimitRow>();
  validPairingRow: Record<string, unknown> | null;

  constructor(opts: FakeDbOptions = {}) {
    this.validPairingRow = opts.validPairingRow ?? null;
  }

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }
}

/// Builds an `Env`-shaped object good enough for the handlers under test.
export function fakeEnv(db: FakeD1): { DB: unknown; JWT_SECRET: string; DEVICE_CONN: unknown } {
  return {
    DB: db,
    JWT_SECRET: 'test-secret-do-not-use-in-prod',
    DEVICE_CONN: {},
  };
}

/// Builds a JSON Request with an attacker-ish client IP header.
export function jsonRequest(
  url: string,
  body: unknown,
  ip = '203.0.113.7',
): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify(body),
  });
}
