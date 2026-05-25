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
| **Releases** | ✅ | v1.1.0 (`15c9f1a`), v1.1.1 (`cd64833`), v1.1.2 (`e9d06cf`); Swift build fix `f6efceb` | — |

Settings lock (formerly "Parent controls", single-device PIN — **different feature**) shipped earlier in 1.0.25 / 1.0.26 and is unrelated to family controls. Don't conflate them.

---

## Phase 2.8 — email sender domain (IN PROGRESS, 2026-05-25)

**Why this is the current open item:** the Resend integration ships and is deployed, but it sends from the **sandbox sender `onboarding@resend.dev`**, which only delivers to the Resend *account owner's* email. Every other beta family's password-reset email silently no-ops. Fix = verify a real domain in Resend and point `EMAIL_FROM` at it.

**Decision (2026-05-25):** register **`focuslock.org`** on Spaceship as the canonical product domain (website, email sender, notifications, recovery, contact). Transactional sender = `FocusLock <noreply@focuslock.org>`. Personal-email forwarding intentionally out of scope.

**The code is already env-driven** — `family-server/src/email.ts` reads `env.EMAIL_FROM` and `env.RESET_URL_BASE`, falling back to `onboarding@resend.dev` and the Vercel reset URL. So shipping 2.8 requires **no functional code change**, only Worker secrets.

### Runbook (operator = Oscar; steps Claude cannot do are marked 🧑)

1. 🧑 **Register `focuslock.org` on Spaceship.**
2. 🧑 **Add the domain in the Resend dashboard** (Domains → Add Domain → `focuslock.org`). Resend generates the records below (region in the MX/SPF host may differ; DKIM key is unique — copy exact values from the dashboard):
   - **MX** — host `send` — value `feedback-smtp.<region>.amazonses.com` — priority `10`
   - **TXT (SPF)** — host `send` — value `v=spf1 include:amazonses.com ~all`
   - **TXT (DKIM)** — host `resend._domainkey` — value `p=MIGf…` (long, no line breaks)
   - **TXT (DMARC, optional)** — host `_dmarc` — value `v=DMARC1; p=none;`
3. 🧑 **Add those records in Spaceship's DNS editor.** Enter only the host part (`send`, `resend._domainkey`, `_dmarc`) — Spaceship appends the domain. Click **Verify** in Resend (DNS can take minutes to ~hours).
4. 🧑 **Rotate the leaked Resend API key** (it was exposed in chat). Create a new key in Resend, delete the old one, then:
   `cd family-server && npx wrangler secret put RESEND_API_KEY`
5. 🧑 **Set the sender secret:**
   `npx wrangler secret put EMAIL_FROM`  → enter `FocusLock <noreply@focuslock.org>`
6. ✅ **Smoke test** (Claude can run / interpret): trigger a reset to a non-owner address and confirm arrival:
   `curl -X POST https://focuslock-family.oscarpetrikas.workers.dev/api/v1/auth/reset-request -H "content-type: application/json" -d '{"email":"<a-real-test-inbox>"}'`
   Then check the destination inbox and `npx wrangler tail` for any Resend errors.

**Heads-up / risk:** the Resend *account login* may itself be a dead `@oscarpetrikas.com` address. The deployed API key still works, but if Oscar is ever logged out, account recovery could be blocked. Once `focuslock.org` email works, consider switching the Resend login/recovery email to an `@focuslock.org` address.

**Follow-on (separate task, not 2.8):** moving the public website + reset link off `focus-lock.vercel.app` onto `focuslock.org` (point DNS at Vercel, set `RESET_URL_BASE`, update `landing/reset.html`'s `API_BASE` only if the Worker also moves to a custom route).

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

- **Phase 2.8 (above)** — sender domain verification is the active blocker for real-family beta email.
- **Signup leaks account existence** via `409 Conflict`. Acceptable in beta; fix when adding email verification.
- **WS push doesn't reach the parent UI** — only child gets pushed rules. Parent UI polls devices every 30s. Optional polish: parent WS to `/parent/ws` for instant device-online state.
- **No automated tests yet** on the Worker. Add Vitest + miniflare.

---

## How to pick this up later

**In a new Claude Code session:**
> "Continue FocusLock family controls — Phase 2.8 email sender domain (focuslock.org / Resend)."

Memory at `~/.claude/projects/C--Users-me/memory/project_focuslock_parental_model.md` autoloads with full context.
