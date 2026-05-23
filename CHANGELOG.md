# Changelog

All notable changes to FocusLock will be documented here.

## [1.1.2] — 2026-05-23

### Added — Family controls

- **Real forgot-password email.** `/auth/reset-request` now actually sends a reset link via Resend instead of only logging the token to worker output. The send is best-effort — the response shape doesn't change whether the email is registered or whether the send succeeded, so account enumeration stays blocked. Falls back to `console.log` when `RESEND_API_KEY` isn't set so dev / self-hosters still boot. Login form gained a "Forgot password?" button → modal → "check your inbox" confirmation.
- **Data portability.** New "Your data" card on the parent dashboard: "Export as JSON" downloads a versioned dump of your account, devices, rules, and audit history (secrets and IP addresses stripped); "Delete account" opens a danger-zone modal that requires password re-entry plus a typed confirmation phrase before the destroy button enables. Deletion is permanent and cascades to every paired device — child devices fall back to unpaired on their next sync.
- **Login + reset-request rate limiting.** Per-email sliding window: 5 failed logins in 15 min triggers a 30-min block; 3 reset requests in 60 min triggers a 60-min block. Failed attempts on a non-existent email are counted equally so 429 vs 401 can't be used to enumerate accounts. Successful login clears the counter so legitimate users aren't punished for typos. The UI just shows the server's message verbatim ("Too many failed attempts. Try again in 30 minutes.") which already reads cleanly in the existing error pill.

## [1.1.1] — 2026-05-22

### Fixed
- **Family tab actually ships this time.** v1.1.0's release workflow forgot to pass `VITE_FAMILY_API_URL` to the Tauri build, so the Family tab was hidden in shipped artifacts even though the backend was live. `release.yml` now reads the URL from a GitHub Actions repository variable and bakes it into the build. Forks without that variable set still get the Family tab hidden (same as 1.0.x), so this isn't a behaviour change for self-hosters.

## [1.1.0] — 2026-05-22 — Family Controls (closed beta)

The first major release on top of the 1.0.x line. Adds cross-device family controls: a parent on one machine can hard-lock specific apps and websites on a child's machine at any time, with cloud sync, anti-bypass hardening, and honest documentation of where the limits are.

**The whole thing is opt-in and gated behind a build-time `VITE_FAMILY_API_URL`** — if you don't run the family-server backend, the Family tab is hidden and FocusLock behaves exactly like 1.0.28.

### Added — Cross-device family controls
- **Family-server backend (`family-server/`).** Cloudflare Worker + D1 + Durable Objects. Endpoints for account auth, device pairing (6-digit codes), device list/delete, lock-rule CRUD, child-side `/device/rules` REST + `/device/ws` WebSocket. JWT-typed tokens (parent-session, device, password-reset) each only valid for their own auth path. Free in beta; ~$5/mo per family for the hosted version once the beta ends. Self-hosters keep the option to run their own server forever.
- **Parent dashboard (Family tab in the desktop app).** Email signup/login, device list with live online dot polled every 30s, "Add device" generates a 6-digit pairing code, per-device block-now form (apps + domains, comma-separated), active-rules list, unpair, and a new **Emergency unblock** button that suppresses every family rule on a device until you clear it (the `unblock_all` kill-switch).
- **Child-pairing flow.** A new "I have a pairing code" tab on the signed-out Family view runs the redeem against the family server, persists the device token under `ProgramData\FocusLock\family.json` (Windows, SYSTEM+Administrators ACL) or `/Library/Application Support/FocusLock/family.json` (macOS, mode 0600). Once paired, the device shows a child-paired view (status, connection state, active rules, unpair) instead of the parent dashboard so a kid can't sign up for their own account to escape the lock.
- **First-run walkthrough.** A 3-step modal — welcome → role pick (parent vs child being paired) → path-specific checklist — appears on first Family-tab visit. Honest about the limits (kid-with-admin-rights = game over). Replayable from the page header.

### Added — Child-daemon enforcement
- **Cloud-sync service** on both Windows (C#) and macOS (Swift) daemons. Persistent WebSocket to the family server, 60-second heartbeats with wall + monotonic clocks, exponential reconnect (2s → 30s), full REST snapshot on every reconnect so a dropped push window can't leave the cache stale.
- **Rule enforcement loop.** Cached `block_now` and `schedule` rules are unioned with any active focus session and applied via the existing hosts-file + process-kill primitives. `unblock_all` acts as a kill-switch. Family rules are enforced *outside* a focus session too — the parent isn't gated on whether the kid happened to start a timer.
- **Schedule rules with cron.** A minimal 5-field parser (`*`, `N`, `N-M`, `N,M`, `*/N`) evaluates schedule rules against the device's local time every tick. Cross-midnight windows take two rules (documented).
- **Local rule cache** survives daemon restarts so the device re-applies the last-known state before the WebSocket reconnects.

### Added — Anti-bypass hardening
- **HMAC-signed family caches.** Both `family.json` and `family-rules.json` ship with a `.sig` sidecar HMAC'd against `daemon.key`. Tampered files fail verify-on-load and are discarded; the device falls back to unpaired / empty cache. A new `family_cache_tampered` audit event is written when this happens.
- **Windows Safe Mode registration.** A hosted service writes `HKLM\SYSTEM\CurrentControlSet\Control\SafeBoot\{Minimal,Network}\FocusLock` at daemon startup so the service still runs after a Shift+Restart bypass attempt.
- **Admin-protected uninstall (Windows).** When a settings-lock PIN is configured, the NSIS uninstaller now requires the parent to explicitly authorize uninstall from inside FocusLock first. The daemon writes a 15-minute token; NSIS checks it via PowerShell on PreUninstall and Aborts with a clear "go authorize this in FocusLock" message when missing or expired.
- **Experimental firewall lockdown.** Opt-in. When the daemon has been offline from the family server for >5 minutes AND has active blocks, the daemon applies per-app/IP firewall rules on top of the kill-process loop:
  - **Windows:** per-EXE-path outbound blocks via `netsh advfirewall`. Resolves running processes' paths so a `discord.exe → notdiscord.exe` rename doesn't escape — the kid has to copy the binary somewhere new.
  - **macOS:** per-IP outbound blocks via a `pfctl` anchor. Resolves cached blocked domains to IPs at engage time so apps that hard-code IPs or ship their own DoH client can't bypass `/etc/hosts`.
  - Fail-open semantics: startup cleanup of stale rules, shutdown cleanup, 10-second timeout per shell-out, no daemon crash on firewall errors.
- **Per-user admin enumeration in the env probe.** The parent dashboard's environment warning now names which local accounts are administrators (and which is the daemon's), with a platform-specific remediation hint. Windows uses `System.DirectoryServices.AccountManagement` and looks up the Administrators group by SID for localisation safety; macOS shells out to `dscl . -read /Groups/admin GroupMembership`.

### Added — Visibility
- **Activity log on parent + child dashboards.** Collapsible card filters the `parent.audit.jsonl` log to family events (pair, unpair, offline >5min, reconnected, tamper detected, uninstall authorized). Same PIN gate as the existing settings-lock audit.
- **Tamper-alert notifications.** A 60s polling loop fires OS notifications for new tamper-class events (`family_cache_tampered`, `family_offline_5min`). Last-seen timestamp persisted in localStorage so reload doesn't re-fire stale alerts.
- **Offline tracking.** `FamilyStatus.offlineSeconds` is surfaced through `family_get_status` and crossing 300 seconds writes a one-shot `family_offline_5min` event. A matching `family_reconnected` lands when the link comes back.

### Notes
- **Beta status.** Closed beta with a handful of friend-families starts now (see `docs/family-controls-beta.md`). The intent is to find what breaks in real-world use, then move to general availability.
- **Honest about limits.** A kid with administrator rights or BIOS access can defeat all of this in minutes — FocusLock is meaningful friction, not a perfect cage. The parent dashboard surfaces this directly via the environment-warning panel.

## [1.0.28] — 2026-05-21

### Added
- **"No turning back" confirmation before starting a Hardcore session.** Flipping the toggle is one thing; *starting* a Hardcore session is the irreversible thing. A confirmation modal now appears between Start and the actual session launch, listing what's about to happen (Stop is disabled, closing the app doesn't end it, killing the daemon doesn't end it, only the timer does). Type `LOCK ME IN` to confirm. Hardcore profiles launched via Quick Start chips get the same gate — no shortcuts around it.

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
