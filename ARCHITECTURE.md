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

### Binary hash verification
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
Uninstall scripts read `session.json` and abort if `endTime > now`.

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
dotnet publish -c Release -r win-x64 --self-contained false -o publish/
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

### macOS installer (PKG)

```bash
# Requires macOS with Xcode CLT
cd installer/macos
chmod +x build-pkg.sh scripts/postinstall
./build-pkg.sh
# Output: FocusLock-1.0.0.pkg
```

---

## Security Notes

- The daemon must run as `SYSTEM` (Windows) or `root` (macOS) to edit the hosts file and kill arbitrary processes.
- The signing key file has OS-enforced access controls — only the daemon user can read it.
- The daemon IPC socket/pipe allows any authenticated local user to connect. Requests that modify session state (start, stop) are validated; the daemon is the sole enforcer of Hardcore Mode and friend lock constraints.
- SIP (macOS): FocusLock does not modify SIP-protected paths. `/etc/hosts` is not SIP-protected. `/Library/LaunchDaemons` requires root but is not SIP-protected.
