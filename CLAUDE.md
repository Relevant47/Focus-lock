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

## Where to see survey + newsletter data

The in-app survey ships data to two places. There is no third place — don't go hunting for one.

**Live host:** the public site runs on `https://tryfocuslock.com` (the registered apex; Vercel project `focus-lock` / `prj_KOtxCyLv3XMSiDnitmLYbtw5ymtT`). The Vercel-assigned alias `https://focus-lock-sable.vercel.app` still works as a backup and remains in `vercel.json`'s CSP alongside the apex. The original first-choice domain `focuslock.app` was unavailable at purchase time — all `focuslock.app` references have been removed from the codebase.

**Survey analytics dashboard:** `https://focus-lock-sable.vercel.app/admin/analytics`
- Supabase magic-link auth → email must be in the `ADMIN_EMAILS` env var on Vercel (comma-separated), or you get 403.
- Top cards (Total responses, Response rate, Avg NPS) hit Supabase live; charts come from the nightly `survey_stats_daily` snapshot refreshed by pg_cron. For a fresh snapshot on demand: `select refresh_survey_stats();` in the Supabase SQL editor.
- "Export CSV" button dumps raw rows. Open-feedback section has a word cloud + Min-NPS / time-range filters.
- Source: `dashboard/src/App.tsx`. API: `api/survey/stats.ts` (`?view=summary` and `?view=opentext`) + `api/survey/export.ts`.

**Newsletter signups:** `https://app.beehiiv.com/subscribers`
- Signups go straight from `landing/newsletter-embed.html` (Beehiiv inline embed iframe'd into the survey) to Beehiiv — we store zero newsletter PII server-side. The `newsletter_optins` table and `api/survey/newsletter*.ts` endpoints have been retired.
- The embed URL carries `utm_source=in-app-survey&utm_medium=app&utm_campaign=in-app-survey`, so filtering on that in Beehiiv isolates survey-flow signups vs. landing-page signups.
- `vercel.json` exempts `/newsletter-embed.html` from the site-wide `X-Frame-Options: DENY` and adds a `frame-ancestors` CSP covering Tauri origins + the live vercel.app host + the apex (`https://tryfocuslock.com`). Don't collapse those two header rules back into one.

**Desktop app → API base URL:** `ui/src/lib/surveyApi.ts` defaults to `https://tryfocuslock.com`; override with `VITE_SURVEY_API_URL` at build time (e.g. preview deployments or self-builds). Already-shipped clients on 1.1.4 and earlier still talk to the Vercel alias — the alias remains live, so they keep working without an update.

**Raw tables (Supabase project `ipmmmebtsbhplcmwkflh`):** `survey_responses` (one row per finished response), `survey_prompts_shown` (denominator for response-rate), `survey_stats_daily` (nightly snapshots).

## Domain, DNS, and email

**Registrar:** `tryfocuslock.com` is registered at **Spaceship**. The originally-planned `focuslock.app` was unavailable at purchase; we settled on `tryfocuslock.com` as the public apex.

**DNS provider:** **Cloudflare** (nameservers `marlowe.ns.cloudflare.com` + `wilson.ns.cloudflare.com` — moved off Spaceship's `launch1/2.spaceship.net`). All DNS records are managed in the Cloudflare dashboard, not at Spaceship. Cloudflare account billing email: `me@oscarpetrikas.com`.

**A record → Vercel:** `@  A  216.198.79.1`. **Set to "DNS only" (gray cloud), NOT proxied** — Vercel runs its own edge/CDN/SSL, and Cloudflare proxying on top double-proxies and breaks Vercel caching, analytics, and certificate handling. If a future record needs Cloudflare features (WAF, etc.) flip just that one to proxied; leave the apex alone.

**Email Routing (inbound only):** Cloudflare Email Routing is enabled. `hello@tryfocuslock.com` and a catch-all (`*@tryfocuslock.com`) both forward to `me@oscarpetrikas.com`. Cloudflare auto-manages 5 records to make this work — 3 MX (`route1/2/3.mx.cloudflare.net`), 1 DKIM TXT (`cf2024-1._domainkey`), 1 SPF TXT (`v=spf1 include:_spf.mx.cloudflare.net ~all`). **Do not edit those manually in Cloudflare DNS** — disable Email Routing first if you need to change MX provider.

**Outbound email is NOT set up yet.** Cloudflare Email Routing is inbound-only. The user currently reads forwarded mail in Apple Mail via Spacemail-hosted `me@oscarpetrikas.com` and replies *from* that personal address (not from `hello@`). The deferred work to unlock proper outbound:
1. Verify `tryfocuslock.com` in Resend (adds DKIM/SPF/return-path records — Cloudflare auto-handles them).
2. Set `EMAIL_FROM="FocusLock <hello@tryfocuslock.com>"` as a `wrangler secret` on the family-server worker so PIN-recovery / password-reset emails stop coming from the `onboarding@resend.dev` sandbox sender (see `docs/family-controls-design.md` Phase 2.6).
3. Add Resend's SMTP credentials to Apple Mail as an outgoing-only account so manual replies appear from `hello@tryfocuslock.com`.

Until step 1 happens, do NOT change `EMAIL_FROM` from the default — Resend will reject sends from an unverified domain.

**Public contact page:** `landing/contact.html` is the canonical contact surface (linked from the index footer's "Project" column + bottom row, and from `changelog.html`). It points to `hello@tryfocuslock.com`. The contact addresses in `landing/privacy.html` § 8, `landing/terms.html` § 8, `landing/reset.html`, and `docs/family-controls-beta.md` all now use `hello@tryfocuslock.com`. The personal `me@oscarpetrikas.com` reference only remains in `scripts/setup-claude-memory.sh` (developer identity, not product contact).
