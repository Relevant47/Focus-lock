import { defineConfig } from 'vitest/config';

// Plain Node environment. The Worker code under test (crypto.ts, rateLimit.ts,
// pairing.ts) relies only on WebCrypto + the standard Request/Response, all of
// which exist in Node 18+. D1 is supplied by the in-memory fake in
// test/helpers.ts, so no miniflare/wrangler runtime is needed for this layer.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
