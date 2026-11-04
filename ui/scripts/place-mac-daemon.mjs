#!/usr/bin/env node
// Post-bundle hook: Tauri places resources at Contents/Resources/Library/...,
// but SMAppService requires the daemon plist at Contents/Library/LaunchDaemons/
// and UsageService.swift resolves the tracker as a sibling of
// Contents/Library/LaunchAgents/. This script moves the daemon binary + plist
// AND the usage-tracker binary to where macOS / the daemon expect them, and
// signs them ad-hoc if no signing identity is configured (dev builds).
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

const daemonSrc = path.join(appPath, 'Contents/Resources/Library/LaunchDaemons');
const daemonDst = path.join(appPath, 'Contents/Library/LaunchDaemons');
const agentsSrc = path.join(appPath, 'Contents/Resources/Library/LaunchAgents');
const agentsDst = path.join(appPath, 'Contents/Library/LaunchAgents');

if (!existsSync(daemonSrc)) {
  console.error(`[place-mac-daemon] no staged daemon at ${daemonSrc} — did tauri.conf.json resources copy them?`);
  process.exit(1);
}

mkdirSync(daemonDst, { recursive: true });

for (const f of ['FocusLockDaemon', 'com.focuslock.daemon.plist']) {
  const a = path.join(daemonSrc, f);
  const b = path.join(daemonDst, f);
  if (!existsSync(a)) {
    console.error(`[place-mac-daemon] missing ${a}`);
    process.exit(1);
  }
  renameSync(a, b);
}

// Ensure the daemon is executable (Tauri's bundle copy may have dropped +x).
chmodSync(path.join(daemonDst, 'FocusLockDaemon'), 0o755);

// Move the usage tracker from Contents/Resources/Library/LaunchAgents/ to
// Contents/Library/LaunchAgents/, matching UsageService.swift's resolver.
if (existsSync(agentsSrc)) {
  mkdirSync(agentsDst, { recursive: true });
  const tracker = 'FocusLockUsageTracker';
  const a = path.join(agentsSrc, tracker);
  const b = path.join(agentsDst, tracker);
  if (!existsSync(a)) {
    console.error(`[place-mac-daemon] missing ${a}`);
    process.exit(1);
  }
  renameSync(a, b);
  chmodSync(b, 0o755);
} else {
  console.error(`[place-mac-daemon] no staged tracker at ${agentsSrc} — did tauri.conf.json resources copy it?`);
  process.exit(1);
}

// Clean up the now-empty Contents/Resources/Library tree.
try {
  rmdirSync(daemonSrc);
  rmdirSync(agentsSrc);
  rmdirSync(path.dirname(daemonSrc));
} catch {
  // not empty or already gone — fine
}

// Re-sign the daemon and tracker if APPLE_SIGNING_IDENTITY is set (CI sets
// this from secrets.APPLE_SIGNING_IDENTITY). Otherwise leave them ad-hoc so
// dev runs work.
const identity = process.env.APPLE_SIGNING_IDENTITY;
if (identity) {
  console.log(`[place-mac-daemon] re-signing binaries with: ${identity}`);
  for (const bin of [
    path.join(daemonDst, 'FocusLockDaemon'),
    path.join(agentsDst, 'FocusLockUsageTracker'),
  ]) {
    try {
      execFileSync(
        'codesign',
        [
          '--force',
          '--options', 'runtime',
          '--sign', identity,
          '--entitlements', path.resolve('../daemon-mac/entitlements.plist'),
          bin,
        ],
        { stdio: 'inherit' },
      );
    } catch (e) {
      console.error(`[place-mac-daemon] codesign failed for ${bin}:`, e?.message ?? e);
      process.exit(1);
    }
  }
}

console.log(`[place-mac-daemon] daemon installed at ${daemonDst}`);
console.log(`[place-mac-daemon] tracker installed at ${agentsDst}`);
