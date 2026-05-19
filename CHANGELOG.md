# Changelog

All notable changes to FocusLock will be documented here.

## [1.0.22] — 2026-05-19

### Fixed
- **Fourth daemon bug:** v1.0.20/v1.0.21 swapped `System.Data.SQLite` → `Microsoft.Data.Sqlite` but the new package's native `e_sqlite3.dll` couldn't be loaded from the single-file bundle, causing the daemon to die with `DllNotFoundException` immediately at startup. Fixed by adding `<IncludeNativeLibrariesForSelfExtract>true</IncludeNativeLibrariesForSelfExtract>` to the daemon's csproj so native libraries are extracted to a temp directory at runtime.

## [1.0.21] — 2026-05-19

### Note
- Same code as 1.0.20 — re-tagged because the v1.0.20 Windows build hung on a stuck GitHub Actions runner and never published. v1.0.21 carries the actual fixes (which themselves had a deeper bug — see 1.0.22).

## [1.0.20] — superseded by 1.0.21 (CI runner hung; never published)

### Fixed
- **Three daemon bugs that broke fresh installs.** v1.0.19's published daemon crashed silently before serving its IPC pipe, leaving the app in a permanent "Daemon not running" state. All fixed:
  - Switched the daemon's SQLite library from `System.Data.SQLite` (incompatible with `PublishSingleFile=true` — caused `ArgumentNullException` during connection init) to `Microsoft.Data.Sqlite`.
  - Loosened the ACL on `C:\ProgramData\FocusLock\daemon.key` to include local Administrators, and wrapped ACL setting in try/catch.
  - Made `IpcPipeService.CreatePipe()` resilient to missing `SeSecurityPrivilege` — falls back to default pipe security if the custom DACL set fails.

From v1.0.21 onward, the daemon works on a fresh install with zero manual intervention.

## [1.0.15] — 2026-05-18

### Fixed
- Re-attempt of v1.0.14's auto-update signing fix. v1.0.14 published but ended up without `.sig` files because the GitHub Secret wasn't reaching CI on that run. This release re-pushes with the secret confirmed in place plus a CI debug step that prints whether the signing key is loaded.

## [1.0.14] — 2026-05-18

### Note
- Published, but `.sig` files were missing — signing key didn't reach the workflow. Superseded by 1.0.15.

## [1.0.13] — superseded by 1.0.14 (build failed; not published)

## [1.0.12] — 2026-05-18

### Fixed
- Iron Will and Accountability achievements now actually unlock — they previously failed to count because the local tag used a random UUID instead of the real daemon-assigned session ID
- Release workflow no longer fails when the Rust cache save step has transient issues (cache failures no longer block publishing)

## [1.0.11] — 2026-05-18

### Added
- **Visual redesign** across every screen — new Linear/Raycast-style design system with Inter font, animated aurora background, film grain, and dramatic gradient typography
- **Command palette** (⌘K / Ctrl+K) — fuzzy-searchable command runner for sessions, navigation, theme toggle, and data export
- **Achievement system** — 9 unlockable achievements (First Block, Iron Will, Streak Warrior, Century, Marathon, Early Bird, Night Owl, Accountability, Consistent) with unlock toast and a full grid on Analytics
- **Focus Intentions** — pre-session prompt asking "what will you focus on?", persisted into the session log and shown on the active Dashboard
- **Daily focus goal** — configurable in Settings (30 min – 8 h), tracked on the Dashboard + sidebar progress bar, with a confetti burst on first hit each day
- **Smart Block Suggestions** — one-click pills with favicons for the most-blocked sites, grouped by Social / Entertainment / Gaming / News
- **Intercept page redesign** — daemon-served block page rebuilt to match the new design system, with a "what were you trying to do?" input that logs the attempt label
- **Onboarding flow rewrite** — four steps: welcome, pick distractions, set daily goal, try a 5-minute session
- **Sidebar redesign** — section-grouped nav, daily progress widget at the bottom, more dramatic active-route glow

### Changed
- Active session view becomes a Pomodoro-aware hero screen with a thick gradient ring, cycle dots, and color shift between work/break/hardcore states
- Session state and logs gain an `intention` field (not signed, like `motivationalMessage`)
- Intercept page now accepts `POST /record-attempt` to log distraction labels

### Removed
- All references to paid tiers, Lemon Squeezy, and trial periods — FocusLock is free, forever

## [1.0.0] — 2025

### Added
- Initial release
- Website blocking via OS hosts file (macOS + Windows)
- App blocking via process kill loop (every 2 seconds)
- Session persistence through reboots
- Hardcore Mode (cryptographically unbreakable sessions)
- Friend Lock with rate-limited token verification
- Pomodoro engine with strict and non-strict break modes
- Break unblocking in non-strict Pomodoro mode
- Scheduled sessions (cron-based, daemon-side)
- Focus profiles with import/export (.focuslock files)
- Quick Block page for ad-hoc sessions without a profile
- System tray with profile quick-launch submenu
- Analytics with weekly bar chart, score sparkline, 52-week heatmap
- CSV and JSON export of session history
- Streak tracking with multiplier in focus score
- Motivational intercept page (custom message + curated quotes)
- OS notifications for session start/end and Pomodoro phase changes
- Light mode / dark mode with persistent preference
- Micro-animations on session state transitions
- Auto-updater via Cloudflare Worker + GitHub Releases
- Binary hash verification on daemon startup
- Service self-repair watchdog (Windows)
- Uninstall protection during active sessions
- 24-hour Hardcore Mode cooldown mechanism
- Wildcard domain blocking (*.example.com)
- Subdomain expansion (www, m, mobile, app, cdn, etc.)
- WiX MSI installer (Windows)
- PKG installer (macOS) with launchd daemon registration
- ARCHITECTURE.md developer documentation
