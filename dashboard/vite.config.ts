import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served at /admin/* on the main site; built into landing/admin so the existing
// Vercel static deploy (outputDirectory: landing) ships it. See vercel.json for
// the buildCommand + SPA rewrite.
export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  resolve: {
    alias: { '@shared': path.resolve(__dirname, '../shared') },
  },
  build: {
    outDir: path.resolve(__dirname, '../landing/admin'),
    emptyOutDir: true,
  },
});
