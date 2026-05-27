# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

FocusLock is a cross-platform (macOS + Windows) distraction blocker that enforces blocks at the OS level — they survive UI close, force quit, crash, logout, and reboot. The repo is a monorepo of independent components written in four languages. Two long-form docs carry the authoritative detail; read them before deep work:

- **`ARCHITECTURE.md`** — IPC protocol, session-state format + HMAC signature, anti-tamper mechanisms, parental-controls model, focus-score / pomodoro / cron algorithms.
- **`family-server/README.md`** — cloud Family Controls endpoints, auth model, WebSocket protocol. `docs/family-controls-design.md` and `docs/family-controls-status.md` track design + current phase.

## Components and their build/dev commands

| Dir | Stack | Dev | Build | Notes |
|-----|-------|-----|-------|-------|
| `ui/` | Tauri 2 + React 18 + TS + Vite + Tailwind + Zustand | `npm run dev` (Vite :1420) or `npm run tauri dev` | `npm run build` (= `tsc && vite build`) | The desktop app. `npm run tauri dev` needs a daemon running. |
| `daemon-win/FocusLock.Daemon/` | C# .NET 8 Worker Service | `dotnet run` | `dotnet build -c Release` | Runs as SYSTEM. Pipe `\\.\pipe\focuslock`. |
| `daemon-mac/` | Swift 5.9 SPM executable | `swift run` | `swift build -c release` → `.build/release/FocusLockDaemon` | Runs as root. Socket `/var/run/focuslock.sock`. |
| `family-server/` | Cloudflare Worker + D1 + Durable Objects (TS) | `npm run dev` (:8787) | `npm run deploy` | See its README for D1 setup + curl walkthrough. |
| `update-server/` | Cloudflare Worker | — | `npx wrangler deploy` | Serves Tauri updater manifest from GitHub releases. |
| `api/` | Vercel serverless fns | — | (Vercel) | Landing-site backend: download, reviews, subscribe. |
| `landing/` | Static site | — | — | Marketing site, deploy anywhere. |

No `npm install` at the repo root — each JS component (`ui/`, `family-server/`, `update-server/`) has its own `package_lock`. Install per-directory.

### CI gates (`.github/workflows/ci.yml` — these must pass on PRs to `main`)

- `npx tsc --noEmit` in `ui/`
- `cargo check --target x86_64-pc-windows-msvc` in `ui/src-tauri` (CI fabricates a placeholder `resources/FocusLockDaemon.exe` first)
- `dotnet build -c Release` in `daemon-win/FocusLock.Daemon`
- `swift build -c release` in `daemon-mac`

There is **no automated test suite**. Verify changes by building each affected component with the command above and by manual run. `release.yml` fires on `v*` tags and produces signed installers.

## Architecture invariants — internalize these

**The daemon is the sole enforcer; the UI is a thin client.** The UI never enforces blocks. It sends newline-delimited JSON requests over the pipe/socket and renders responses. All session state, anti-tamper, friend-lock, parental-PIN, and pomodoro logic lives in the daemon. Never move enforcement decisions into the UI or Rust layer.

**`shared/protocol.ts` is the single source of truth for IPC types.** The UI imports it via the `@shared` path alias (`ui/src/types/index.ts` re-exports from `@shared/protocol`). The C# (`daemon-win/.../Models/`) and Swift (`daemon-mac/Sources/.../Models.swift`) types are hand-mirrored from it. **Changing a message shape means editing protocol.ts AND both daemon Models in lockstep** — there is no codegen keeping them in sync.

**The two daemons are deliberate parallel ports.** `daemon-win/FocusLock.Daemon/Services/` and `daemon-mac/Sources/FocusLockDaemon/` contain the same service set under matching names — `HostsFileService`/`HostsService`, `ProcessKillService`, `SessionService`, `ScheduleService`, `CronEvaluator`, `InterceptHttpService`, `ParentService`, `FamilyService`, `FamilyEnforcementService`, `CloudSyncService`, `IntegritySigner`, etc. **A behavior change to one platform almost always needs the mirror change on the other.** Treat a one-sided daemon change as a bug unless the difference is platform-specific (firewall APIs, Safe-Mode registration, SIP).

**Session state is HMAC-signed on disk and re-read on restart.** The daemon signs `session.json` with a key only it can read; tampering is detected and logged but does NOT bypass the lock. The signature covers the fields listed in `ARCHITECTURE.md` — note `motivationalMessage` and `intention` are intentionally excluded. If you add a signed field, update the signature payload in both daemons and the comment in `protocol.ts`.

**UI ↔ daemon goes through one Rust command.** `ui/src-tauri/src/lib.rs` exposes `ipc_request` (plus updater/installer commands). The Zustand `daemon` store (`ui/src/stores/daemon.ts`) wraps it in a `request(type, payload)` helper and applies the parent-PIN gate via `withParentGate` / `lib/parentGate.ts`. Add new daemon calls through that store, not ad-hoc `invoke`s scattered in components.

**Parental controls are friction, not security.** Open source + daemon-on-child's-machine means a determined admin can always uninstall. The PIN gate targets impulse-resistance. Don't represent it as airtight.

## Conventions

- The canonical GitHub repo is `github.com/Relevant47/focus-lock`. URLs to `Relevant47` throughout `landing/`, `ui/src/pages/Settings.tsx`, and the update server are real — don't "fix" them. Forking means a project-wide find-replace of `Relevant47`.
- The `ui/` app version (`package.json` `version`) is the user-facing app version; bump it for releases.
- Secrets/keys (updater key, signing certs) are supplied at build/release time, never committed — see README "Building for release" and the GitHub Secrets table.
