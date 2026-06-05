# Family Controls — Status Checkpoint

**As of:** 2026-05-25
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
| Phase 2.3 + 2.4 — child daemon WS + anti-bypass (Win + Mac) | ✅ | `daemon-win/.../Services/{FamilyService,FamilyEnforcementService,CloudSyncService,IntegritySigner,CronEvaluator,SafeModeRegistration}.cs`; `daemon-mac/Sources/FocusLockDaemon/Family*.swift` | `f7d6e59` |
| Phase 2.5 — UI polish, onboarding, tamper alerts, emergency unblock, uninstall gate, firewall lockdown | ✅ | `ui/src/pages/Family.tsx`, `ui/src/lib/auditEvents.ts`, daemon `FirewallLockdownService` (Win + Mac pfctl) | `63c2baa`→`f79916f`, `00eec97` |
| Phase 2.6 — real password-reset email via Resend | ✅ | `family-server/src/email.ts`, `landing/reset.html`, UI `ForgotPasswordButton` | `da8a924` |
| Phase 2.7 — account export + delete (data portability) | ✅ | `family-server/src/account.ts` | `27be5a0` |
| Phase 2.9 — per-email rate limiting (login + reset) | ✅ | `family-server/src/rateLimit.ts`, migration `0002_auth_rate_limits.sql` | `eefce7f` |
| Phase 2.8 — verified Resend sender domain (`hello@tryfocuslock.com`) | ✅ | Worker secrets only (`RESEND_API_KEY` rotated, `EMAIL_FROM`, `RESET_URL_BASE`); no source change | — (config) |
| **Releases** | ✅ | v1.1.0 (`15c9f1a`), v1.1.1 (`cd64833`), v1.1.2 (`e9d06cf`); Swift build fix `f6efceb` | — |

Settings lock (formerly "Parent controls", single-device PIN — **different feature**) shipped earlier in 1.0.25 / 1.0.26 and is unrelated to family controls. Don't conflate them.

---

## Phase 2.8 — email sender domain (SHIPPED, 2026-06-05)

**Was:** the Resend integration was deployed but used the sandbox sender `onboarding@resend.dev`, which only delivers to the Resend account owner. Every other beta family's reset email silently no-op'd.

**Now:** Resend is verified for `tryfocuslock.com` (Cloudflare auto-added the DKIM/SPF/return-path records via Resend's "Connect Cloudflare" integration). The Worker uses these three secrets — set, not committed:

| Secret | Value |
|--------|-------|
| `RESEND_API_KEY` | (new, rotated 2026-06-05; the older `focuslock-family-prod` / `focus-lock-family-server` keys were deleted) |
| `EMAIL_FROM` | `FocusLock <hello@tryfocuslock.com>` |
| `RESET_URL_BASE` | `https://tryfocuslock.com/reset.html` |

Verified end-to-end: outbound `POST /api/v1/auth/reset-request` calls Resend, which returns HTTP 200 + an email ID; sent messages now appear in the Resend dashboard with `From: FocusLock <hello@tryfocuslock.com>` (no code change to `family-server/src/email.ts` — Phase 2.6 already made it env-driven).

### Gotcha: `.html` in `RESET_URL_BASE`

The natural value would have been `https://tryfocuslock.com/reset` (matching the original Vercel default `…/reset` shape). But `vercel.json` doesn't have `cleanUrls: true` and has no `/reset` → `/reset.html` rewrite, so `/reset` 404s on the live apex. We use `.html` in the secret as the simple fix. If you want the clean URL back, add this entry to `vercel.json`'s `rewrites` and re-set the secret to `…/reset`:

```json
{ "source": "/reset", "destination": "/reset.html" }
```

### Follow-on (separate task)

- **Switch the Resend *account-login* address** from the current `@oscarpetrikas.com` (which the status doc previously flagged as possibly dead) to `hello@tryfocuslock.com` now that inbound mail to it works via Cloudflare Email Routing — otherwise a logout could lock out account recovery.

---

## Locked product decisions (don't relitigate without a reason)

From design doc, decided 2026-05-21:

1. **Pricing:** free in beta, paid (~$5/mo per family) after Phase 2.5. Single-device FocusLock stays free forever. Self-hosters always free.
2. **Server code:** open-source, same GPL-3.0 repo (lives at `family-server/`).
3. **Non-admin child account:** mandatory, with auto-setup via `New-LocalUser` PowerShell on Windows, manual walkthrough on Mac.
4. **Password recovery:** email reset, instant (no 24h delay). Trade-off accepted: kid with brief parent-email access can reset.
5. **Mobile parent app:** deferred to Phase 3+.

---

## Architecture in one paragraph

Parent device (Tauri app, `ui/src/pages/Family.tsx`) signs in to a Cloudflare Worker (`family-server/`). Worker stores data in D1 (`accounts`, `devices`, `pairing_codes`, `lock_rules`, `audit_log`, `auth_rate_limits`) and uses one Durable Object per device (`DeviceConnection`) to hold a live WebSocket. Parent creates a pairing code → child daemon redeems it → child gets a 1-year device-bound JWT → child opens a WebSocket to `/api/v1/device/ws` → server pushes rule changes in real-time. Heartbeats from child update `last_seen_at` (throttled to 1 DB write/min). Three token kinds with distinct claims (parent session = no `kind`, device = `kind:'device'+did`, password reset = `kind:'reset'`) and each auth middleware rejects the wrong kind.

---

## Known issues / TODOs (small, do whenever)

- **Signup leaks account existence** via `409 Conflict`. Acceptable in beta; fix when adding email verification.
- **WS push doesn't reach the parent UI** — only child gets pushed rules. Parent UI polls devices every 30s. Optional polish: parent WS to `/parent/ws` for instant device-online state.
- **No automated tests yet** on the Worker. Add Vitest + miniflare.

---

## How to pick this up later

Phases 2.1–2.9 are all shipped. The remaining loose ends are the small bullets in "Known issues / TODOs" above and the Resend account-login switch noted under Phase 2.8.

Memory at `~/.claude/projects/-Users-oscarpetrikas/memory/MEMORY.md` autoloads with full context.
