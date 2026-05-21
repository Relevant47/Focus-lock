# Changelog

All notable changes to FocusLock will be documented here.

## [Unreleased] — Phase 2.3 + 2.4 (family controls, child-daemon hookup + anti-bypass hardening)

### Added — Phase 2.3
- **Family controls — child daemon hooked up to the cloud.** The Windows C# and macOS Swift daemons now sync with the family server: persistent WebSocket to `/api/v1/device/ws`, 60-second heartbeats carrying both wall and monotonic clocks, exponential-backoff reconnect (2s → 30s). On every reconnect the daemon pulls the current rule set via REST before re-opening the WS, so a dropped push window can't leave the cache stale. Rules are cached locally so a daemon restart re-applies the last-known state immediately.
- **`block_now` and `unblock_all` enforcement.** When the parent pushes a `block_now` rule from their dashboard, the child daemon's enforcement loop unions the rule's target apps + domains with anything the user's own focus session is blocking, and applies the combined set via the existing hosts file + process-kill primitives. `unblock_all` acts as a kill-switch that suppresses family-side enforcement entirely (useful for "homework site got blocked at 11pm — let it through"). Family rules are enforced *outside* a focus session too — the parent isn't gated on whether the kid happened to start a focus timer.
- **Pairing flow on the child device.** New IPC messages `family_redeem_code`, `family_unpair`, `family_get_status`. Redeeming a 6-digit pairing code POSTs to `/api/v1/family/pair/redeem`, persists the returned device token under `ProgramData\FocusLock\family.json` (Windows, ACL: SYSTEM + Administrators only) or `/Library/Application Support/FocusLock/family.json` (macOS, mode 0600) — both unreadable from a non-admin child user account. Pairing-code redemption is gated behind the existing settings PIN when one is configured, so a child can't re-pair their own device to a different parent account to escape an existing lock.

### Added — Phase 2.4 (anti-bypass hardening)
- **HMAC-signed family caches.** Both `family.json` (device token + parent-account binding) and `family-rules.json` (cached cloud rules) now ship with a `.sig` sidecar — a hex HMAC-SHA256 computed against the same `daemon.key` SessionService uses. Any tampered cache fails verification at load time and is discarded: the device falls back to "unpaired" or "no rules" rather than honouring the edit. The new `IntegritySigner` (C#) / `IntegritySigner.swift` is reusable for any future signed file.
- **Schedule-rule cron enforcement.** A minimal 5-field cron parser (`*`, `N`, `N-M`, `N,M,O`, `*/N`) evaluates each `schedule` rule against the device's local time on every enforcement tick. Matching rules contribute to the same hosts/process union as `block_now`, so scheduled blocks land within one second of a minute boundary. Cross-midnight windows (e.g. weekday 9pm–6am) are not auto-expressible in a single cron; users compose two rules — documented in the design doc.
- **Offline tracking + audit.** `FamilyStatus.offlineSeconds` is now surfaced through `family_get_status`. When the WebSocket has been disconnected for >5 minutes, the daemon writes a one-shot `family_offline_5min` event to the parent audit log; a matching `family_reconnected` event lands when the link comes back. Outage detection runs on the reconnect loop so the alert is delivered within ~30 seconds of crossing the threshold. Pair/unpair are audited too (`family_paired` / `family_unpaired`).
- **Windows Safe Mode registration.** A `SafeModeRegistration` hosted service writes `HKLM\SYSTEM\CurrentControlSet\Control\SafeBoot\{Minimal,Network}\FocusLock = "Service"` at daemon startup so the service starts when the user reboots into Safe Mode — without it, holding Shift while clicking Restart was a one-click bypass. Best-effort: failures are logged and the daemon keeps running.
- **`family_check_environment` IPC.** Returns a small `FamilyEnvironment` snapshot — platform, OS version, daemon-elevation status, UAC-enabled flag (Windows). The parent setup flow can use this to surface "this account is administrator — set up a non-admin child account first" before pairing.

### Notes
- **No client UI for entering the pairing code yet.** The IPC plumbing and protocol types are in place; the child-side "Enter pairing code from parent" screen is a separate UI task. Same for the `FamilyEnvironment` UI surface.
- **Offline lockdown is "honour the cache + audit" only.** Aggressive deny-all-with-allowlist via Windows Firewall / pfctl was deferred — the daemon-only path is enough to make offline a non-bypass (cached `block_now` and matching `schedule` rules keep enforcing) and the firewall layer carries enough cross-platform / fail-closed risk to warrant its own phase.
- **Installer hardening (admin-protected uninstall via NSIS/WiX) is still open.** Daemon side is ready — the Safe Mode key is written; the cache+config files are signed; the env-probe IPC exists — but the actual NSIS/WiX uninstall gate still needs to be wired up next time we cut a release.

## [1.0.27] — 2026-05-21

### Added
- **Hardcore toggle right on the Dashboard start screen.** Previously Hardcore mode was only configurable per-profile, so you had to set up a dedicated "Hardcore" profile to use it. Now there's a clear toggle below the duration picker on the main start screen: flip it on and the session cannot be stopped early no matter what — the daemon refuses early-stop commands until the timer ends. Flip it off and you can stop anytime. The toggle pre-fills from the selected profile (if any) so it Just Works either way.

## [1.0.26] — 2026-05-21

### Changed
- **Renamed "Parent controls" → "Settings lock".** The 1.0.25 feature has always been a single-device anti-self-bypass PIN — you lock your own settings so you can't disable FocusLock when willpower fails. Calling it "Parent controls" implied a parent-on-one-device-controlling-a-child-on-another setup that doesn't actually exist (yet). The label was misleading, so it's now "Settings lock" with copy that's honest about the use case: stopping you from disabling FocusLock in a moment of weakness. No behavior changes — same PIN, same recovery key, same audit log.

### Coming soon
- **Cross-device family controls** (the actual parental controls). A future major release will add a real parent-device → child-device feature: parent logs in on their machine and can hard-lock specific apps on the child's machine at any time, with cloud sync and child-side anti-bypass. This is a multi-week build, separate from this release.

## [1.0.25] — 2026-05-20

### Added
- **Parental controls.** Set a 4-digit PIN in Settings → Parent controls to lock down profile editing, block lists, and other settings behind it. Any settings change now prompts for the PIN. A 16-character recovery key is shown once when you set the PIN — save it somewhere safe, because it's the only way to clear the PIN if you forget it. Every PIN action (set, unlock, failed attempt, recovery-key reset) is written to a tamper-evident audit log. The same logic ships in both the Windows C# daemon and the Swift macOS daemon, so the lock holds whether you swap machines or remove the app.

## [1.0.24] — 2026-05-19

### Fixed
- **Installer now auto-requests admin elevation.** The Windows installer was failing to register the daemon service for users who double-clicked the .exe (the `sc.exe create` step in the NSIS post-install hook needs admin, which the installer wasn't requesting). Set `installMode: "perMachine"` in the Tauri NSIS config so the installer triggers the Windows UAC prompt on launch instead of silently failing the service registration. Now any user can double-click the installer, click "Yes" on the UAC dialog, and the daemon registers + starts automatically — no more right-click → Run as administrator.

## [1.0.23] — 2026-05-19

### Fixed
- **THE auto-update bug.** Every single release from v1.0.18 onward had a one-character typo in the `pubkey` field of `tauri.conf.json`. Releases were correctly signed with the matching private key, but every installed app verified against the wrong pubkey — so every "Update available" prompt failed with `"signature was created with a different key than the one provided"`. v1.0.23 fixes the pubkey to exactly match `updater.key.pub`. **One last fresh install is required to escape this — every install v1.0.18-v1.0.22 has the corrupted pubkey baked in. From v1.0.23 onward, auto-update will actually work.**

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
