/**
 * Generates all icon sizes required by Tauri from icon.svg.
 *
 * Usage:
 *   cd focus-lock
 *   npm install --save-dev sharp
 *   node scripts/generate-icons.mjs
 *
 * Then run:
 *   cd ui && npm run tauri icon ../icon.svg
 * (tauri-cli will also generate icons from the SVG directly if you prefer)
 */

import sharp from 'sharp';
import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const root  = join(__dir, '..');
const svg   = readFileSync(join(root, 'icon.svg'));
const out   = join(root, 'ui', 'src-tauri', 'icons');

mkdirSync(out, { recursive: true });

const sizes = [16, 32, 64, 128, 256, 512, 1024];
const tasks = sizes.map(async (size) => {
  const file = join(out, `${size}x${size}.png`);
  await sharp(svg).resize(size, size).png().toFile(file);
  console.log(`  ✓ ${size}x${size}.png`);
});

// Also write a 128x128@2x (256px)
tasks.push(
  sharp(svg).resize(256, 256).png().toFile(join(out, '128x128@2x.png'))
    .then(() => console.log('  ✓ 128x128@2x.png'))
);

await Promise.all(tasks);

// For Windows ICO we just copy the 256px PNG — Tauri handles ICO conversion
// For macOS ICNS Tauri also handles conversion from PNG
// The tauri CLI will pick up all PNGs in the icons/ directory.

console.log('\n✓ All icons generated in ui/src-tauri/icons/');
console.log('  Next: cd ui && npm run tauri build');
