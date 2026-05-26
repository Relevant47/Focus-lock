import path from 'path';
import { defineConfig } from 'vitest/config';

// Tests run in a Node environment (pure logic + API handlers with mocked fetch).
// Excluded from `tsc --noEmit` via tsconfig "exclude" so CI's build gate stays clean.
export default defineConfig({
  resolve: {
    alias: { '@shared': path.resolve(__dirname, '../shared') },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
