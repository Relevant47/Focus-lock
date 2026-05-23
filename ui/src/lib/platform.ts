// Synchronous platform detection for UI gating. We can't use the daemon env
// probe (it's async + requires a connected daemon) just to decide which chip
// to render, so we sniff the webview user agent. Tauri 2 surfaces the real OS
// here — "Macintosh" on macOS, "Windows" on Windows.
//
// If we ever need finer detail (Linux variants, ARM vs x64), switch to
// `@tauri-apps/plugin-os` and make this async.

export type Platform = 'windows' | 'macos' | 'other';

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'other';
  const ua = navigator.userAgent || '';
  if (/Win(dows|32|64|NT)/i.test(ua)) return 'windows';
  if (/Mac(intosh| OS X)/i.test(ua)) return 'macos';
  return 'other';
}

export const PLATFORM: Platform = detectPlatform();
export const IS_WINDOWS = PLATFORM === 'windows';
export const IS_MACOS = PLATFORM === 'macos';
