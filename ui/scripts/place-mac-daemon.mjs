#!/usr/bin/env node
// Post-bundle hook: Tauri places resources at Contents/Resources/Library/...,
// but SMAppService requires the daemon plist at Contents/Library/LaunchDaemons/.
// This script moves the daemon binary + plist to where macOS expects them, and
// signs the daemon ad-hoc if no signing identity is configured (dev builds).
//
// Usage:
//   node scripts/place-mac-daemon.mjs [path/to/FocusLock.app]
//
// Default app path: src-tauri/target/release/bundle/macos/FocusLock.app

import { existsSync, mkdirSync, renameSync, rmdirSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const DEFAULT_APP = 'src-tauri/target/release/bundle/macos/FocusLock.app';
const appPath = path.resolve(process.argv[2] || DEFAULT_APP);

if (!existsSync(appPath)) {
  console.error(`[place-mac-daemon] app bundle not found: ${appPath}`);
  process.exit(1);
}

const src = path.join(appPath, 'Contents/Resources/Library/LaunchDaemons');
const dst = path.join(appPath, 'Contents/Library/LaunchDaemons');

if (!existsSync(src)) {
  console.error(`[place-mac-daemon] no staged daemon at ${src} — did tauri.conf.json resources copy them?`);
  process.exit(1);
}

mkdirSync(dst, { recursive: true });

for (const f of ['FocusLockDaemon', 'com.focuslock.daemon.plist']) {
  const a = path.join(src, f);
  const b = path.join(dst, f);
  if (!existsSync(a)) {
    console.error(`[place-mac-daemon] missing ${a}`);
    process.exit(1);
  }
  renameSync(a, b);
}

// Ensure the daemon is executable (Tauri's bundle copy may have dropped +x).
chmodSync(path.join(dst, 'FocusLockDaemon'), 0o755);

// Clean up the now-empty Contents/Resources/Library tree.
try {
  rmdirSync(src);
  rmdirSync(path.dirname(src));
} catch {
  // not empty or already gone — fine
}

// Re-sign the daemon if SIGN_IDENTITY env var is set (CI sets this from
// secrets.APPLE_SIGNING_IDENTITY). Otherwise leave it ad-hoc so dev runs work.
const identity = process.env.APPLE_SIGNING_IDENTITY;
if (identity) {
  console.log(`[place-mac-daemon] re-signing daemon with: ${identity}`);
  try {
    execFileSync(
      'codesign',
      [
        '--force',
        '--options', 'runtime',
        '--sign', identity,
        '--entitlements', path.resolve('../daemon-mac/entitlements.plist'),
        path.join(dst, 'FocusLockDaemon'),
      ],
      { stdio: 'inherit' },
    );
  } catch (e) {
    console.error('[place-mac-daemon] codesign failed:', e?.message ?? e);
    process.exit(1);
  }
}

console.log(`[place-mac-daemon] daemon installed at ${dst}`);
