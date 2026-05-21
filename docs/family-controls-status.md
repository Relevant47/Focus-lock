# Family Controls — Status Checkpoint

**As of:** 2026-05-21
**Where to read first:** [`family-controls-design.md`](./family-controls-design.md) — the architecture and the 5 locked product decisions.

This file exists so anyone (you, future-Claude, a contributor) can pick up the cross-device family-controls work without re-reading the whole project. Keep it updated as phases land.

---

## What's done

| Phase | Status | Where it lives | Commit |
|-------|--------|----------------|--------|
| Design doc + locked decisions             | ✅ | `docs/family-controls-design.md`        | `78cdac5`, `aa472bd` |
| Phase 2.1 — server scaffold + auth slice  | ✅ | `family-server/` (auth.ts, crypto.ts)   | `fa61987` |
| Phase 2.2 — server pairing/devices/rules/WS | ✅ | `family-server/` (pairing.ts, devices.ts, do.ts, router.ts) | `54fb6fa` |
| Phase 2.2 — parent dashboard UI           | ✅ | `ui/src/pages/Family.tsx`, `ui/src/stores/family.ts`, `ui/src/lib/familyApi.ts` | `589129b` |
| Phase 2.3 — child daemon WS client (Win)  | ⏭️ | `daemon-win/FocusLock.Daemon/` — does not exist yet | — |
| Phase 2.3 — child daemon WS client (Mac)  | ⏭️ | `daemon-mac/Sources/FocusLockDaemon/` — does not exist yet | — |
| Phase 2.3 — pairing-code entry UI in child | ⏭️ | `ui/src/pages/Family.tsx` currently parent-only — needs a child mode | — |
| Phase 2.4 — anti-bypass hardening         | ⏭️ | monotonic clock, Safe-Mode reg, admin-uninstall, non-admin-account gate | — |
| Phase 2.5 — polish + closed beta          | ⏭️ | onboarding flows, audit-log UI, tamper alerts | — |

Settings lock (formerly "Parent controls", single-device PIN — **different feature**) shipped earlier in 1.0.25 / 1.0.26 and is unrelated to family controls. Don't conflate them.

---

## What you need to do before any of this works for real users

1. `cd family-server && npm install`
2. `npm run db:create` — paste the printed `database_id` into `wrangler.toml`
3. `npm run db:migrate:remote` — apply schema to production D1
4. `npm run secret:set-jwt` — paste output of `openssl rand -hex 32`
5. `npm run deploy` — push the Worker live
6. Note the deployed URL (e.g. `https://focuslock-family.<your-subdomain>.workers.dev`)
7. Set `VITE_FAMILY_API_URL=<that URL>` when building the FocusLock UI (or put it in `ui/.env.local` for `npm run tauri dev`)
8. Run the curl walkthrough in `family-server/README.md` to confirm signup → pair → block flow works end-to-end via the API
9. **Then** start Phase 2.3 — the child daemons need to know the same URL

---

## Locked product decisions (don't relitigate without a reason)

From design doc, decided 2026-05-21:

1. **Pricing:** free in beta, paid (~$5/mo per family) after Phase 2.5. Single-device FocusLock stays free forever. Self-hosters always free.
2. **Server code:** open-source, same GPL-3.0 repo (lives at `family-server/`).
3. **Non-admin child account:** mandatory, with auto-setup via `New-LocalUser` PowerShell on Windows, manual walkthrough on Mac. Phase 2.4 builds this gate into the onboarding flow.
4. **Password recovery:** email reset, instant (no 24h delay). Trade-off accepted: kid with brief parent-email access can reset.
5. **Mobile parent app:** deferred to Phase 3+.

---

## Architecture in one paragraph

Parent device (Tauri app, `ui/src/pages/Family.tsx`) signs in to a Cloudflare Worker (`family-server/`). Worker stores data in D1 (`accounts`, `devices`, `pairing_codes`, `lock_rules`, `audit_log`) and uses one Durable Object per device (`DeviceConnection`) to hold a live WebSocket. Parent creates a pairing code → child daemon redeems it → child gets a 1-year device-bound JWT → child opens a WebSocket to `/api/v1/device/ws` → server pushes rule changes in real-time. Heartbeats from child update `last_seen_at` (throttled to 1 DB write/min). Three token kinds with distinct claims (parent session = no `kind`, device = `kind:'device'+did`, password reset = `kind:'reset'`) and each auth middleware rejects the wrong kind.

---

## Phase 2.3 — what it looks like when it's time to build it

**Child daemon side (Windows C# + Mac Swift, must be at parity):**
- Read paired-device credentials from on-disk config (`C:\ProgramData\FocusLock\family.json` / `/var/db/focuslock/family.json`); HMAC-sign so the kid can't hand-edit
- Background task: open WS to `${SERVER_URL}/api/v1/device/ws` with `Authorization: Bearer <device-token>`
- On `rule_change` / `rule_delete` / `unpair` messages, update local rule cache and apply via the existing block engine (hosts file, process kill loop, intercept HTTP)
- Send `{type:'heartbeat'}` every 60s; ack means alive
- On WS drop, exponential backoff reconnect (1s → 2s → 4s → … → 60s cap); on reconnect, `GET /api/v1/device/rules` to re-sync (don't trust only the WS to deliver state)
- After 5 min offline: enter "precautionary lock" — disable all non-allowlist network until reconnected

**Child UI side (in the existing FocusLock app, child mode):**
- Onboarding flow: "Is this a child device in a family?" → "Enter the 6-digit pairing code your parent gave you"
- POST to `/api/v1/family/pair/redeem` with hostname + OS info
- Store the returned device token; show "Linked to family account <accountId>"
- Hide profile/blocklist editing from the child (those are now parent-controlled)
- A read-only "What's being blocked right now and by whom" view

**File-level prediction:**
- `daemon-win/FocusLock.Daemon/Services/CloudSyncService.cs` — new
- `daemon-mac/Sources/FocusLockDaemon/CloudSyncService.swift` — new
- `shared/protocol.ts` — extend with cloud-side rule types
- `ui/src/pages/Family.tsx` — add `<ChildMode>` branch (or split into `ParentMode` / `ChildMode` based on device state)
- `ui/src/stores/family.ts` — extend store to know if local device is paired-as-child

---

## How to pick this up later

**In a new Claude Code session:**
> "Continue Phase 2.3 of FocusLock family controls — child daemon WebSocket clients on Windows C# and Mac Swift."

Memory at `~/.claude/projects/C--Users-me/memory/project_focuslock_parental_model.md` will autoload with full context.

**Outside Claude:**
Read this file + `family-controls-design.md` + skim `family-server/README.md`. That's the full picture in ~30 minutes.

---

## Known issues / TODOs (small, do whenever)

- **Signup leaks account existence** via `409 Conflict`. Acceptable in beta; fix when adding email verification (then signup always returns 200 and email confirmation is the gate).
- **Email reset link is `console.log` only.** Wire to Resend/SendGrid/Postmark when ready to onboard real beta users. Add a `RESEND_API_KEY` Worker secret.
- **No rate limiting yet** on `/auth/login` or `/pair/redeem`. Cloudflare's built-in WAF covers brute-force at the IP level. Add per-account/per-code limits before public launch (D1 + KV counter pattern).
- **WS push doesn't reach the parent UI** — only child gets pushed rules. Parent UI polls devices every 30s. Phase 2.4 polish: parent WS to `/parent/ws` so device-online state updates instantly.
- **No tests yet.** Add Vitest + miniflare for the Worker once Phase 2.3 lands.
- **Account data export ("GDPR" button)** flagged in design doc but not built. Bolt in during Phase 2.5.
