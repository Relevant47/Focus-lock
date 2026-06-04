# macOS daemon self-heal & SMAppService migration

**Date:** 2026-06-05
**Status:** Design — ready for implementation planning
**Owner:** Oscar
**Touches:** `daemon-mac/`, `ui/src-tauri/`, `ui/src/`, `installer/macos/` (deletion), `.github/workflows/release.yml`, `ARCHITECTURE.md`, `CLAUDE.md`, `CHANGELOG.md`, `landing/changelog.html`

## Problem

A FocusLock user can end up with the UI installed but the daemon missing, with no in-app recovery path. The UI silently fails to connect to `/var/run/focuslock.sock`. This was observed on the maintainer's own Mac on 2026-06-04: `FocusLock.app` was in `/Applications` and running, but `/Library/PrivilegedHelperTools/FocusLockDaemon` and `/Library/LaunchDaemons/com.focuslock.daemon.plist` were absent. Recovery required manually running the install commands with `sudo`.

A second, related problem surfaced during recovery: the daemon's custom hash-based tamper check (`/Library/Application Support/FocusLock/daemon.hash`) does not survive legitimate daemon updates. Any rebuild produces a `Daemon binary hash mismatch — binary may have been tampered with` warning. With auto-updates shipping new daemons regularly, this would fire on essentially every update.

Windows already has a self-heal path: `ui/src-tauri/src/lib.rs:66-118` calls `sc.exe start`, and on missing service runs `install-service.ps1` with UAC elevation. macOS has no equivalent — line 130 returns `"Not supported on this platform"`.

## Goals

1. A user on macOS who has `FocusLock.app` should never see a non-recoverable "daemon not running" state.
2. The first-install experience requires at most one admin password prompt.
3. Subsequent launches and auto-updates require zero admin prompts.
4. Tamper detection survives every legitimate update without operator intervention.
5. Distribution simplifies to a single signed artifact.

## Non-goals

- Changes to the Windows installer or self-heal flow.
- Changes to the daemon's enforcement logic, IPC protocol, or session-state signing.
- Support for macOS versions below 13 Ventura.
- An automated test suite. Verification stays manual (per `CLAUDE.md`).

## Decisions (locked)

| # | Decision | Rationale |
|---|---|---|
| D1 | Use Apple's `SMAppService` API for daemon registration. | macOS 13+ is the floor; SMAppService is Apple's blessed mechanism, replaces deprecated `SMJobBless`, and handles the admin prompt and System Settings integration natively. |
| D2 | Daemon binary and plist ship inside `FocusLock.app/Contents/Library/LaunchDaemons/`. | This is the path SMAppService expects. It also guarantees: if the .app exists, the daemon binary exists. |
| D3 | Drop the `.pkg` installer. Ship only a signed `.dmg` containing `FocusLock.app`. | One artifact, one install path, matches modern Mac apps (1Password, Little Snitch). Eliminates an entire class of "user installed the .app from somewhere else" bugs. |
| D4 | Replace the `daemon.hash` tamper check with `SecCodeCheckValidity` against the FocusLock Apple Developer Team ID. | Stronger (catches modification *and* unsigned replacement), survives every legit update, and is the standard pattern. Team ID is stable across cert renewals. |
| D5 | Windows path is unchanged. macOS deliberately diverges from Windows here. | Windows still uses NSIS + a Windows service; the asymmetry is unavoidable and is documented in `CLAUDE.md`. |
| D6 | macOS 13 Ventura is the minimum supported version. | Released October 2022, covers ~95% of active Macs. Required for SMAppService. |

## Architecture overview

```
┌──────────────────────────────────────────────────────────────────┐
│ /Applications/FocusLock.app                                      │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ Contents/MacOS/focus-lock          ← Tauri UI binary         │ │
│ │ Contents/Library/LaunchDaemons/                              │ │
│ │   ├─ FocusLockDaemon               ← Swift daemon binary     │ │
│ │   └─ com.focuslock.daemon.plist    ← launchd plist           │ │
│ └──────────────────────────────────────────────────────────────┘ │
└───────────────────────────────┬──────────────────────────────────┘
                                │ SMAppService.daemon(plistName:).register()
                                ▼
                ┌───────────────────────────────────┐
                │ macOS launchd (system)            │
                │ runs FocusLockDaemon as root      │
                │ listens on /var/run/focuslock.sock│
                └───────────────────────────────────┘
                                ▲
                                │ Unix socket
                                │
                ┌───────────────┴───────────────────┐
                │ Tauri UI (user-space)             │
                │ ipc_request → ipc_call → socket   │
                └───────────────────────────────────┘
```

`/Library/PrivilegedHelperTools/` and `/Library/LaunchDaemons/` are no longer used by FocusLock on macOS.

## Components

### New code

**`ui/src-tauri/src/macos_daemon.rs`** — a small Rust module that bridges to `SMAppService` via the `objc2` crate. Exposes two functions:

- `register_and_start() -> Result<RegisterOutcome, String>` — calls `SMAppService.daemon(plistName: "com.focuslock.daemon.plist").register()` and returns one of:
  - `Running` — service registered and the process is alive.
  - `RequiresApproval` — registration succeeded but user must approve in System Settings (or just denied the prompt).
  - `Err(String)` — anything else, with macOS error string for diagnostics.
- `status() -> ServiceStatus` — calls `SMAppService.daemon(...).status` and returns `NotRegistered | Enabled | RequiresApproval | NotFound`.

**`ui/src/pages/SetupRequired.tsx`** — the recovery screen. Three states driven by Rust's return value:

- `not-registered` (first launch, no socket): "Enable background service" CTA → calls `invoke('install_daemon')`.
- `disabled` (user disabled in System Settings, or denied prompt): explainer + "Open Login Items" button that deep-links to `x-apple.systempreferences:com.apple.LoginItems-Settings.extension`.
- `tampered` / `error` (signature check failure or unrecoverable error): "Reinstall from official source" message with a link to `https://tryfocuslock.com` and a "Copy diagnostics" button (collects `launchctl print system/com.focuslock.daemon`, last 5 min of `log show --predicate 'subsystem == "com.focuslock.daemon"'`, and the tail of `/Library/Logs/FocusLock/daemon.log`).

### Files modified

- **`ui/src-tauri/tauri.conf.json`** — add `daemon-mac/.build/release/FocusLockDaemon` and `daemon-mac/com.focuslock.daemon.plist` to macOS bundle resources, targeting `Contents/Library/LaunchDaemons/`.
- **`ui/src-tauri/src/lib.rs`** — replace the macOS arm of `install_daemon` (currently `Err("Not supported on this platform")`) with a call into `macos_daemon::register_and_start()`. Keep the same return shape so the React code is unchanged.
- **`ui/src-tauri/Cargo.toml`** — add `objc2`, `objc2-foundation`, and `objc2-service-management` (or current crate names) under `[target.'cfg(target_os = "macos")'.dependencies]`.
- **`daemon-mac/com.focuslock.daemon.plist`** — replace `ProgramArguments` with `BundleProgram = "Contents/Library/LaunchDaemons/FocusLockDaemon"` (the key SMAppService expects). Update `WorkingDirectory` and `StandardErrorPath` / `StandardOutPath` to keep logs at `/Library/Logs/FocusLock/daemon.log` (still writable as root).
- **`daemon-mac/Sources/FocusLockDaemon/main.swift`** (or wherever startup runs) — replace the hash check with `SecCodeCheckValidity` against the Team ID. Dev-build bypass: skip the check if `FOCUSLOCK_DEV_BUILD=1` is set OR if the binary's signature is ad-hoc / missing.
- **`daemon-mac/Sources/FocusLockDaemon/IntegritySigner.swift`** (or wherever the hash logic lives) — delete hash-writing entirely. The daemon no longer reads or writes `/Library/Application Support/FocusLock/daemon.hash`.
- **`ui/src/stores/daemon.ts`** — `init()` already sets `connected: false` when the socket is missing. Add a one-shot `attemptDaemonInstall()` action that calls `invoke('install_daemon')` and then re-polls. `SetupRequired.tsx` wires to this.
- **`ui/src/App.tsx`** (or wherever top-level routing lives) — route to `SetupRequired` when `connected === false` after `init()` has completed at least one poll cycle.
- **`ARCHITECTURE.md`** — add a "macOS install model" section describing SMAppService, the in-bundle daemon location, the code-signature check, and the deliberate divergence from Windows.
- **`CLAUDE.md`** — update the components table (no more `installer/macos/`), note that macOS uses SMAppService and Windows uses NSIS, and remove references to `/Library/PrivilegedHelperTools/`.
- **`.github/workflows/release.yml`** — remove `.pkg` build steps; keep the existing `.dmg` produced by Tauri. Update notarization and signing steps to point at the `.dmg`.
- **`CHANGELOG.md`** and **`landing/changelog.html`** — document the new install flow (per the always-update-changelog memory).

### Files deleted

- `installer/macos/install.sh`
- `installer/macos/uninstall.sh`
- `installer/macos/build-pkg.sh`
- `installer/macos/distribution.xml`
- `installer/macos/scripts/postinstall`
- `installer/macos/scripts/` (empty)
- `installer/macos/` (empty)

## Data flow — the four scenarios

### a) First launch on a clean Mac

1. User opens the `.dmg`, drags `FocusLock.app` to `/Applications`, double-clicks it.
2. Tauri window opens. `daemon.init()` tries to connect to `/var/run/focuslock.sock` → fails.
3. UI routes to `SetupRequired` with state `not-registered`.
4. User clicks "Enable background service". Rust calls `macos_daemon::register_and_start()` → `SMAppService.daemon(plistName:).register()`.
5. macOS shows its native dialog: *"FocusLock would like to add background items."* User authenticates with Touch ID / password.
6. launchd reads the bundled plist, starts the daemon, socket appears.
7. UI's existing poll loop reconnects, routes to main screen.

### b) Subsequent launches

1. Socket already exists (daemon is running as root, started at boot by launchd).
2. UI connects in milliseconds. Main screen renders. No prompts.

### c) App update via Tauri updater

1. Updater replaces `/Applications/FocusLock.app` and relaunches.
2. New bundled daemon is inside the new bundle. `SMAppService` is registered against the bundle, not against an absolute path; launchd picks up the new daemon on its next start cycle.
3. Rust calls `register_and_start()` defensively on every launch. If status is `Enabled` and socket is healthy → no-op. If launchd is still running the old daemon → triggers reload. No admin prompt — registration is already approved.
4. Socket reconnects. User sees nothing.

### d) User disables the service in System Settings → Login Items

1. macOS stops the daemon. Socket disappears.
2. Next UI launch sees missing socket. Rust calls `status()` → returns `RequiresApproval` or `NotRegistered` depending on what the user did.
3. UI routes to `SetupRequired` with state `disabled`, showing the System Settings deep-link button.
4. Once user re-enables, daemon starts. UI auto-reconnects via the existing poll loop.

**Edge case — first admin prompt denied:** `register()` returns `RequiresApproval`. Same `disabled` recovery screen, same deep-link button.

## Error handling

### Registration failures (Rust → UI)

| Error | Mapping | UI behavior |
|---|---|---|
| `kSMErrorAlreadyRegistered` | `Running` (fall through to socket check) | Proceed to main screen if socket connects. |
| `kSMErrorAuthorizationFailure` (user denied / cancelled) | `RequiresApproval` | `SetupRequired` `disabled` state with "Try again" button. |
| Other (corrupted plist, wrong identifier, macOS bug) | `Err(String)` | `SetupRequired` `error` state with the message and "Copy diagnostics" button. |
| Socket exists but `connect()` times out | Treated as not-running; one `register_and_start()` retry. If still fails, `error` state. | — |

### Code-signature failures (daemon side)

- `SecCodeCheckValidity` against the Team ID fails → daemon logs `[security] code signature check failed: <OSStatus>` and exits with code 1. Refusing to run is the point.
- launchd's `KeepAlive` + `ThrottleInterval: 5` will retry. The UI sees a persistent missing socket → `SetupRequired` `tampered` state: *"FocusLock's background service can't verify its own signature. Reinstall from the official .dmg."* with a download link to `https://tryfocuslock.com`.
- **Dev-build bypass:** `FOCUSLOCK_DEV_BUILD=1` env var (set by `daemon-mac`'s `swift run` wrapper) or detected ad-hoc / missing signature → check skipped, log `[security] DEV BUILD — code signature check skipped`. Production `.dmg` builds never set this flag.

### Update-time edge cases

- New `.app` has a different code-signing leaf cert (cert rotation) → daemon validates against the **Team ID**, which is stable across cert renewals. No issue.
- Updater replaces `.app` while daemon is running → `register_and_start()` on next UI launch triggers a reload; old daemon process exits via its existing SIGTERM handler.

## Existing-install migration (one-time cleanup)

On first launch of the new version, the UI invokes Rust `cleanup_legacy_install()` once, gated by a `UserDefaults` flag `migrated_to_smappservice = true`. It is best-effort:

1. Detect whether any of the legacy paths exist:
   - `/Library/LaunchDaemons/com.focuslock.daemon.plist`
   - `/Library/PrivilegedHelperTools/FocusLockDaemon`
   - `/Library/Application Support/FocusLock/daemon.hash`
2. If any exist, show the UI prompt: *"Upgrading FocusLock's background service — one admin password needed once."* with a "Continue" button.
3. Shell out via `osascript -e 'do shell script "..." with administrator privileges'`. The shell command does, in order:
   - `launchctl unload /Library/LaunchDaemons/com.focuslock.daemon.plist` (best-effort, ignore failure)
   - `rm -f /Library/PrivilegedHelperTools/FocusLockDaemon`
   - `rm -f /Library/LaunchDaemons/com.focuslock.daemon.plist`
   - `rmdir /Library/PrivilegedHelperTools 2>/dev/null || true`
   - `rm -f "/Library/Application Support/FocusLock/daemon.hash"`
4. Preserve `/Library/Application Support/FocusLock/` itself and the other files there (`daemon.key`, `parent.tokenkey`, session state). The new daemon will continue to read and write these.
5. After the shell-out, call `SMAppService.register()`. If macOS prompts for admin again here, that's acceptable — but in practice the osascript already elevated the parent shell context. **One password prompt total for upgrading users** is the target; if testing shows two, fall back to documenting it as a one-time two-prompt upgrade.
6. Set `migrated_to_smappservice = true`. Subsequent launches skip this entire block.

**Fresh installs** (no legacy files detected) skip the cleanup entirely and go straight to `register_and_start()`.

## Testing & verification

Per `CLAUDE.md` there is no automated test suite. Verification is manual:

| Scenario | Expected outcome |
|---|---|
| Fresh `.dmg` install on a clean Mac (use a VM, or manually `sudo launchctl unload /Library/LaunchDaemons/com.focuslock.daemon.plist && sudo rm -rf /Library/PrivilegedHelperTools/FocusLockDaemon /Library/LaunchDaemons/com.focuslock.daemon.plist "/Library/Application Support/FocusLock" /Applications/FocusLock.app` first) | Drag `.app` → launch → one Touch ID prompt → main screen. Reboot → main screen, no prompt. |
| Upgrade from a previous `.pkg` install of FocusLock | One Touch ID prompt at first launch ("upgrading background service"). Legacy `/Library/PrivilegedHelperTools/` and `/Library/LaunchDaemons/com.focuslock.daemon.plist` are gone. `/Library/Application Support/FocusLock/daemon.key` is preserved. |
| User disables FocusLock in System Settings → Login Items | UI shows `SetupRequired` `disabled` state with working deep-link. Re-enabling restores connection without restart of UI. |
| User denies the initial admin prompt | UI shows `SetupRequired` `disabled` state. "Try again" re-runs `register()`. |
| App auto-update (e.g. 1.2 → 1.3) | No admin prompt. New daemon binary picked up. Socket reconnects within seconds. |
| Tamper test: `sudo cp /usr/bin/cat /Applications/FocusLock.app/Contents/Library/LaunchDaemons/FocusLockDaemon` | Daemon exits with code-sig failure. UI eventually shows `SetupRequired` `tampered` state. (Note: invalidates code-sig of whole bundle on disk; this is destructive and only for local test.) |
| Dev workflow: `cd daemon-mac && swift run` while UI runs via `npm run tauri dev` | Daemon starts with `DEV BUILD — code signature check skipped` log line. UI connects. |
| Windows regression sanity: install via NSIS `.exe`, launch UI, verify daemon still self-heals | Unchanged behavior. |
| Mirror-parity audit: every C# service still has its Swift counterpart per `CLAUDE.md`. | No drift introduced by this migration. |

## Open questions

None — all decisions are locked above.

## Rollout

1. Land this in `main` behind no flag (the SMAppService path is the only macOS path after the change).
2. Bump `ui/package.json` version (e.g. `1.2.0` if currently `1.1.x`, since install model is a breaking change for upgraders).
3. Update `CHANGELOG.md` and `landing/changelog.html` (per the always-update-changelog memory).
4. CI release builds `.dmg` only; old `.pkg` consumers get the in-app updater path which delivers the new `.dmg`-built `.app`, triggering the one-time migration.
5. Monitor `/Library/Logs/FocusLock/daemon.log` reports in support emails (`hello@tryfocuslock.com`) for the first week.
