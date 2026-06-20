# FocusLock — Developer Architecture

## Overview

FocusLock is a cross-platform (macOS + Windows) productivity app that blocks websites and
applications at the operating system level. Blocks survive UI close, force quit, crash,
logout, and system reboot.

```
┌─────────────────────────────────────────┐
│           FocusLock UI                  │  Tauri + React + TypeScript
│  Dashboard / Block Lists / Profiles     │  Runs as normal user
│  Schedules / Analytics / Settings       │
└───────────────────┬─────────────────────┘
                    │ IPC (newline-delimited JSON)
       Named Pipe (Windows)  /  Unix Socket (macOS)
                    │
┌───────────────────▼─────────────────────┐
│         FocusLock Daemon                │  Runs as SYSTEM (Win) / root (mac)
│  - Session state (HMAC-signed, on disk) │
│  - Hosts file management + DNS flush    │
│  - Process kill loop (every 2s)         │
│  - Schedule engine (cron)               │
│  - Intercept HTTP server (port 80)      │
│  - Friend lock + rate limiting          │
└─────────────────────────────────────────┘
```

---

## Repository Structure

```
focus-lock/
├── shared/
│   └── protocol.ts          IPC message types (source of truth)
├── ui/
│   ├── src/                 React frontend
│   ├── src-tauri/           Rust/Tauri backend
│   └── package.json
├── daemon-win/
│   └── FocusLock.Daemon/    C# .NET 8 Worker Service
├── daemon-mac/
│   └── Sources/             Swift daemon (SPM)
└── installer/
    ├── windows/             PowerShell + WiX scripts
    └── macos/               Shell scripts + PKG components
```

---

## IPC Protocol

Both platforms use **newline-delimited JSON** over a local transport:

| Platform | Transport           | Path                      |
|----------|---------------------|---------------------------|
| Windows  | Named pipe          | `\\.\pipe\focuslock`      |
| macOS    | Unix domain socket  | `/var/run/focuslock.sock` |

Every message is a single JSON object terminated by `\n`.

### Request format

```json
{ "type": "<command>", "payload": { ... } }
```

### Response format

```json
{ "type": "ok" | "error" | "status" | "profiles" | "logs" | "schedules" | "pong",
  "payload": { ... },
  "message": "<error string if type=error>" }
```

### Commands

| Command | Payload | Response |
|---------|---------|----------|
| `ping` | — | `pong` |
| `get_status` | — | `status` → `DaemonStatus` |
| `start_session` | `StartSessionPayload` | `ok` / `error` |
| `stop_session` | `{ unlockToken? }` | `ok` / `error` |
| `skip_break` | — | `ok` / `error` |
| `request_disable_hardcore` | — | `ok` / `error` |
| `get_profiles` | — | `profiles` → `FocusProfile[]` |
| `save_profile` | `FocusProfile` | `ok` |
| `delete_profile` | `{ id }` | `ok` |
| `get_logs` | `{ limit }` | `logs` → `SessionLog[]` |
| `get_schedules` | — | `schedules` → `ScheduledSession[]` |
| `save_schedule` | `ScheduledSession` | `ok` |
| `delete_schedule` | `{ id }` | `ok` |
| `record_block_attempt` | `{ domain?, process? }` | `ok` |
| `set_parent_pin` | `{ pin, oldPin? }` | `ok` / `error` |
| `verify_parent_pin` | `{ pin }` | `parent_token` / `error` |
| `change_parent_pin` | `{ oldPin, newPin }` | `ok` / `error` |
| `clear_parent_pin` | `{ pin }` | `ok` / `error` |
| `get_parent_audit` | `{ limit?, parentToken? }` | `parent_audit` → `ParentAuditEntry[]` |

---

## Session State Format

Stored at:
- Windows: `%ProgramData%\FocusLock\session.json`
- macOS: `/Library/Application Support/FocusLock/session.json`

```json
{
  "sessionId": "uuid-v4",
  "profileId": "uuid-v4 | null",
  "startTime": "2025-01-01T09:00:00Z",
  "endTime":   "2025-01-01T10:30:00Z",
  "hardcoreMode": false,
  "blockedDomains": ["youtube.com", "..."],
  "blockedProcesses": ["steam.exe"],
  "allowlistedDomains": ["docs.google.com"],
  "pomodoroConfig": null,
  "unlockTokenHash": "sha256-hex | null",
  "motivationalMessage": "Stay focused. | null",
  "signature": "hmac-sha256-hex"
}
```

### Signature computation

```
payload = sessionId|startTime|endTime|hardcoreMode|
          blockedDomains(csv)|blockedProcesses(csv)|
          allowlistedDomains(csv)|unlockTokenHash
signature = HMAC-SHA256(signingKey, payload)
```

The signing key is a 32-byte random value stored at:
- Windows: `%ProgramData%\FocusLock\daemon.key` (SYSTEM-only ACL)
- macOS: `/Library/Application Support/FocusLock/daemon.key` (chmod 600)

Tampering with `session.json` produces a signature mismatch. The daemon logs a warning
and continues enforcing the session — the tampered file does NOT bypass the lock.

---

## Anti-Tamper Mechanisms

### Binary verification (macOS)
On startup the daemon calls `SecCodeCheckValidity` against FocusLock's Apple
Developer Team ID (see `daemon-mac/Sources/FocusLockDaemon/CodeSignatureCheck.swift`).
A mismatch — modified binary, unsigned replacement, or wrong signer — exits with
code 1; launchd's `KeepAlive` keeps retrying, the retries keep failing, and the UI
eventually shows the "reinstall from official source" screen. Ad-hoc signed
binaries (the output of `swift build` for local dev) are detected and the check is
bypassed, so `swift run` continues to work. `FOCUSLOCK_DEV_BUILD=1` is an
additional bypass for explicit dev workflows.

The earlier `daemon.hash` (SHA-256-of-own-binary) mechanism is retired — it fired
on every legitimate update because the recorded hash never matched a freshly-built
daemon.

### Binary hash verification (Windows)
On first run the daemon SHA-256 hashes its own executable and stores the hash.
On subsequent starts it re-hashes and compares — a mismatch is logged.

### Hosts file re-enforcement
The hosts file is rewritten every 30 seconds during an active session.
Manual edits are overwritten on the next tick.

### Process kill loop
Blocked processes are polled and killed every 2 seconds.
An app killed by the daemon cannot stay open for more than 2 seconds after launch.

### Session persistence
On daemon restart (crash, reboot), `session.json` is read back and blocks are
re-applied immediately — before the user's desktop is fully loaded.

### Friend lock
The raw unlock token is never stored. Only `SHA-256(token)` is written to
session state. Rate-limiting: 10s → 30s → 60s → 5min backoff per failed attempt.

### Uninstall protection
**Windows (shipped NSIS installer, `ui/src-tauri/nsis-hook.nsh`):** the
pre-uninstall hook gates uninstall behind the **settings-lock PIN** when one
is configured. The daemon writes a `%ProgramData%\FocusLock\uninstall-authorized.token`
(Unix-epoch expiry on the first line, 15-minute TTL) only after a
PIN-verified `family_authorize_uninstall` IPC call (`IpcPipeService.HandleAuthorizeUninstall`).
The NSIS hook reads that token, validates the expiry, deletes it, and only
then proceeds to `sc.exe stop`/`delete`. **Without a settings-lock PIN
configured (the common case for solo/productivity users), the hook is a
no-op** and uninstall proceeds immediately — consistent with the "friction,
not security" framing in `CLAUDE.md`. Neither the hook nor the daemon
currently checks `session.json`; an active session does not block uninstall.

**Legacy `installer/windows/uninstall.ps1`:** the off-pipeline manual
PowerShell uninstaller still contains the older `session.json` / `endTime`
check. That script is **not** invoked by the shipped NSIS installer.

**macOS:** no uninstall-time gate. `SMAppService` registration can be
revoked from System Settings → Login Items, and the `.app` can be dragged
to Trash like any other app. As on Windows, this reflects the
"friction, not security" framing — a determined admin on the local
machine can always uninstall.

---

## macOS install model

The macOS daemon ships **inside** `FocusLock.app/Contents/Library/LaunchDaemons/` and is registered with launchd via Apple's `SMAppService` API. There is no separate `.pkg`, no `/Library/PrivilegedHelperTools/`, and no manual `launchctl load`. On first launch the UI calls `SMAppService.daemon(plistName:).register()` through a small Swift FFI bridge (`ui/src-tauri/swift-bridge/`); macOS shows one admin prompt; launchd starts the daemon. Subsequent launches and auto-updates require zero prompts.

The plist (`daemon-mac/com.focuslock.daemon.plist`) uses `BundleProgram` — not `ProgramArguments` — to point at the daemon binary relative to the bundle root. This is the only key SMAppService accepts.

If the user disables the service in System Settings → Login Items, the UI detects the missing socket on next launch and routes to `SetupRequired` (`ui/src/pages/SetupRequired.tsx`) with a deep link to the relevant System Settings pane.

**Legacy upgrade:** users coming from a previous `.pkg` install see a one-time "Upgrading FocusLock" screen that runs an `osascript` admin shell-out to remove `/Library/PrivilegedHelperTools/FocusLockDaemon`, `/Library/LaunchDaemons/com.focuslock.daemon.plist`, and the stale `daemon.hash`. `/Library/Application Support/FocusLock/daemon.key` and other session state are preserved.

**Asymmetry with Windows:** Windows still uses an NSIS-installed Windows service (`daemon-win/`) and the existing self-heal in `ui/src-tauri/src/lib.rs:try_install_daemon_sync`. The two platforms deliberately diverge here — see `CLAUDE.md`.

---

## Parental Controls

A PIN gates sensitive mutations so a child running FocusLock can't disable enforcement without the parent's authorization. **This is friction, not absolute security** — FocusLock is open source, the daemon runs on the child's machine, and a determined admin user can always uninstall. The model targets impulse-resistance, not airtight enforcement. For stronger lockdown, install FocusLock under a Windows admin account and give the child a standard user.

### Gated commands
- `save_profile` / `delete_profile`
- `save_schedule` / `delete_schedule`
- `request_disable_hardcore`
- `stop_session` (in addition to any friend-lock token)
- `get_parent_audit`

When no PIN is configured, the gate is a no-op and all commands behave exactly as before.

### PIN storage

PINs are hashed with PBKDF2-SHA256 (200,000 iterations, 16-byte random salt, 32-byte output).

| Platform | Path |
|----------|------|
| Windows  | `%ProgramData%\FocusLock\parent.cred` (SYSTEM + Administrators ACL) |
| macOS    | `/Library/Application Support/FocusLock/parent.cred` (chmod 600) |

### Grace tokens

A successful `verify_parent_pin` returns a base64url-encoded token valid for 5 minutes:

```
token = base64url("<expiryUnixSeconds>.<HMAC-SHA256(tokenKey, expiryUnixSeconds)>")
```

`tokenKey` is a 32-byte random value persisted at `parent.tokenkey` (same ACL as `parent.cred`). The UI caches the token in memory only — never disk — and supplies it as `parentToken` on subsequent gated requests until it expires.

### Rate limiting

Failed PIN attempts follow the same ladder as friend-lock: 10s → 30s → 60s → 5min. Reset on successful verify.

### Audit log

Append-only JSONL at `parent.audit.jsonl` (same directory and ACL as `parent.cred`). One record per line:

```json
{ "timestamp": "2026-05-20T03:52:09Z", "event": "gate_blocked", "command": "save_profile", "detail": null }
```

Event types:
- `pin_set`, `pin_changed`, `pin_cleared` — PIN configuration changes
- `pin_verify_success`, `pin_verify_fail`, `pin_verify_rate_limited` — verification attempts
- `gate_blocked`, `gate_allowed` — every gate decision (the `get_parent_audit` read itself is gated, so reading the log records a `gate_allowed` for `get_parent_audit`)

Read via `get_parent_audit` IPC. The read is gated when a PIN is configured; it is open when no PIN is set (nothing privileged to protect).

---

## Hosts File Blocking

Blocked domains are written as:
```
# ── FocusLock START ──
# Managed by FocusLock — do not edit manually
127.0.0.1 youtube.com
127.0.0.1 www.youtube.com
127.0.0.1 m.youtube.com
# ── FocusLock END ──
```

Redirecting to `127.0.0.1` (not `0.0.0.0`) lets the intercept HTTP server
on port 80 serve a branded block page instead of a generic browser error.

HTTPS sites still get a cert error (host-level blocking cannot intercept TLS),
but the connection is refused — the site is effectively blocked.

### Pattern expansion

| Input | Expands to |
|-------|-----------|
| `youtube.com` | `youtube.com`, `www.youtube.com`, `m.youtube.com`, `mobile.youtube.com`, … |
| `*.youtube.com` | root + all common subdomains |

---

## Intercept HTTP Server

The daemon listens on `127.0.0.1:80`. When a browser resolves a blocked domain
to `127.0.0.1` and makes an HTTP request, it receives a branded dark-mode page
showing time remaining, block attempts, and the user's motivational message
(or a rotating curated quote if none was set).

The page auto-refreshes every 10 seconds.

---

## Focus Score Algorithm

```
base  = max(100 - min(blockAttempts × 5, 50), 10)
streak_multiplier = 1.0 + min(currentStreak × 0.02, 0.20)   // +2%/day, max +20%
score = min(floor(base × streak_multiplier), 100)
score = 0 if session was stopped early
```

---

## Pomodoro Engine

State machine in daemon:
```
work → break → work → break → ... → long_break → work → ...
       (after cyclesBeforeLongBreak work phases)
```

- `strictMode = true`: break phase cannot be skipped; blocking remains active during breaks
- `skip_break` IPC command: immediately advances to next work phase (only in non-strict mode)

---

## Cron Schedule Format

5-field cron: `minute hour day month weekday`

- `*` — any value
- `1-5` — range
- `1,4` — list
- `*/2` — step

Example: `0 9 * * 1-5` = weekdays at 9:00 AM

---

## Build Instructions

### Windows daemon

```powershell
cd daemon-win/FocusLock.Daemon
dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o publish/
```

### macOS daemon

```bash
cd daemon-mac
swift build -c release
# Binary at: .build/release/FocusLockDaemon
```

### UI (both platforms)

```bash
cd ui
npm install
npm run tauri build
```

### Windows installer

**PowerShell (quick):**
```powershell
# Copy publish/ output to installer/windows/daemon/
# Copy Tauri build output to installer/windows/ui/
cd installer/windows
.\install.ps1
```

**WiX MSI (production):**
```powershell
dotnet tool install --global wix
wix build FocusLock.wxs -o FocusLock.msi
```

### macOS installer (DMG)

```bash
# Requires macOS with Xcode CLT
cd daemon-mac && swift build -c release
cd ../ui && npm run tauri build
# Output: ui/src-tauri/target/release/bundle/dmg/FocusLock_*.dmg
#         ui/src-tauri/target/release/bundle/macos/FocusLock.app
```

The daemon binary is staged into `ui/src-tauri/target/daemon-stage/` by `build.rs`
and bundled into `FocusLock.app/Contents/Library/LaunchDaemons/` by Tauri's
resource step. On first launch the UI calls `SMAppService.register()` via the
Swift bridge to ask launchd to start the daemon — see the "macOS install model"
section above.

The `.pkg` installer was retired in favor of this single-artifact flow.

---

## Security Notes

- The daemon must run as `SYSTEM` (Windows) or `root` (macOS) to edit the hosts file and kill arbitrary processes.
- The signing key file has OS-enforced access controls — only the daemon user can read it.
- The daemon IPC socket/pipe allows any authenticated local user to connect. Requests that modify session state (start, stop) are validated; the daemon is the sole enforcer of Hardcore Mode and friend lock constraints.
- SIP (macOS): FocusLock does not modify SIP-protected paths. `/etc/hosts` is not SIP-protected. `/Library/LaunchDaemons` requires root but is not SIP-protected.
