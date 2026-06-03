# Family Controls — Design Doc

**Status:** Design only. No code committed yet.
**Author:** Design session 2026-05-21.
**Target release:** 1.1.0 (multi-week build, see [Phased Plan](#phased-build-plan)).

---

## What this is — and isn't

"Family controls" = a **parent on one device** can hard-lock specific apps on a **child's device**, at any time, from anywhere. Cloud sync in the middle.

This is **not** the 1.0.25 "Settings lock" feature (single-device, anti-self-bypass PIN). Those are two different products that happen to share the word "lock." This doc is only about cross-device.

**Target user:** parents of real kids (under 18, hard-resistant). Threat model assumes the kid will try to:
- Kill the daemon
- Uninstall FocusLock
- Edit the registry / config files
- Change the system clock to bypass timers
- Boot into safe mode / a USB / dual-boot
- Reinstall the OS

Some of those we can mitigate; some we genuinely can't without OS-level integration. We'll be honest about which is which.

---

## What's possible in a Tauri/desktop app — vs not

Be very clear-eyed about this. Companies like **Bark, Qustodio, and Microsoft Family Safety** have full engineering teams *and still* get bypassed. A determined teenager will find a way around any pure-userspace solution. FocusLock can be **a meaningful friction layer**, not a perfect cage.

| Bypass attempt              | Can FocusLock prevent? | How                                                                 |
|-----------------------------|------------------------|---------------------------------------------------------------------|
| Kill daemon process         | Yes                    | Watchdog service auto-restarts (already exists)                     |
| Uninstall via Settings      | Mostly                 | Run installer with admin-only uninstall; require parent-device confirmation to remove |
| Edit FocusLock config files | Yes                    | DACL/ACL on `C:\ProgramData\FocusLock\` (already exists); HMAC-signed state (already exists) |
| Change system clock         | Yes                    | Daemon uses monotonic clock for timers (small change)               |
| Boot Safe Mode              | **Partial**            | Register daemon to start in Safe Mode (Windows: SafeBoot registry); doesn't help on Mac |
| Boot from USB / dual-boot   | **No**                 | Out of scope for a desktop app. Mitigated only by BIOS lock + disk encryption (parent's responsibility) |
| Reinstall OS                | **No**                 | Out of scope. Parent's account on the cloud service still has the lock active, so reinstalling and signing in re-enforces — but the kid can use a different OS install without signing in |
| Child has admin rights      | **Game over**          | Without a non-admin child account, every protection above is bypassable in seconds |

**The single most important thing a parent must do:** make the child's OS account **non-administrator**. Without that, nothing FocusLock does matters. This must be the first step in the parent-onboarding flow, with a hard gate ("we detected this account is an administrator — set up a non-admin account before continuing").

---

## Architecture overview

```
┌──────────────────────┐                 ┌──────────────────────┐
│  PARENT DEVICE       │                 │  CHILD DEVICE        │
│  (any platform)      │                 │  (Win or Mac)        │
│                      │                 │                      │
│  FocusLock UI        │                 │  FocusLock UI        │
│  (parent dashboard)  │                 │  (read-only mode)    │
│         │            │                 │         │            │
│         ▼            │                 │         ▼            │
│  Local daemon        │                 │  Local daemon        │
│  (optional —         │                 │  (enforces blocks    │
│   parent's own       │                 │   from cloud rules)  │
│   FocusLock too)     │                 │                      │
│         │            │                 │         ▲            │
└─────────┼────────────┘                 └─────────┼────────────┘
          │                                       │
          │   HTTPS + WebSocket                   │   HTTPS + WebSocket
          ▼                                       ▼
       ┌───────────────────────────────────────────┐
       │       Cloud Backend                       │
       │  - Account + auth                         │
       │  - Device pairing                         │
       │  - Lock rules (per child device)          │
       │  - Real-time push to child                │
       │  - Heartbeat from child                   │
       │  - Audit log                              │
       └───────────────────────────────────────────┘
```

**Connection model:** child daemon holds a persistent WebSocket to the cloud. Falls back to short-poll (every 30s) if WS drops. Parent sends commands → cloud → child via WS. Child reports state via heartbeat (every 60s).

---

## Server stack — recommendation: Cloudflare Workers + D1 + Durable Objects

You're already on Cloudflare for the updater worker. Sticking with it means:
- Same auth tokens, same bills, same deploy story
- D1 (SQLite) for accounts, devices, rules, audit log
- Durable Objects for per-device WebSocket connections (real-time push to child)
- Workers KV for hot-path lookups (device → current lock state)
- Cost at small scale: ~$5/mo

**Alternatives considered:**

| Option         | Pros                                                | Cons                                                        |
|----------------|-----------------------------------------------------|-------------------------------------------------------------|
| **Cloudflare** (recommended) | Already in use; cheapest; global edge; Durable Objects perfect for WS-per-device | D1 is newer/less mature than Postgres; vendor lock-in       |
| **Supabase**   | Postgres + Realtime + Auth bundled; great DX        | More expensive at scale; another vendor; less control over edge |
| **Firebase**   | Mature; great mobile SDKs                           | Google account dependency; harder to migrate off later      |
| **Self-hosted (Fly.io + Postgres)** | Full control                          | You become the SRE; ops burden for an OSS project           |

**Decision:** Cloudflare. Migrate to Postgres-backed solution later if D1 limits hurt (current D1 limits are well past hobbyist-scale, so unlikely soon).

---

## Account + auth model

**Account = parent.** A parent account owns a family. A family contains: 1 parent (later: multiple parents) + N child devices.

**Sign-up:** email + password. Magic-link option as nice-to-have. No social login on day 1 — adds complexity, OAuth flows in a Tauri webview are painful.

**Session tokens:**
- Parent device: standard 30-day JWT, refresh on app launch
- Child device: long-lived (1-year) device-bound token, rotated on each heartbeat, **never shown in child-side UI** so the kid can't copy and sign in on their own machine

**2FA on parent account:** TOTP (Google Authenticator etc.) — Phase 3+. Important because compromised parent account = kid unlocks everything.

**Recovery:** Email-only password reset, **instant** (no delay). *Trade-off accepted:* a kid who briefly gets parent-email access can reset the password and sign in. The simpler flow won over the 24h Apple-Family-Sharing-style delay — revisit if we see this abused in beta.

---

## Pairing flow

How does the child device become linked to the parent's account?

**Recommended flow ("device code"):**
1. Parent on their device → Family Controls → "Add child device" → cloud generates a 6-digit code, valid for 10 minutes, shown prominently in the parent UI
2. Parent installs FocusLock on child device (or it's already installed); during onboarding the child UI shows "Enter pairing code from parent"
3. Child enters code → daemon POSTs to cloud `/pair` with the code → cloud links device to parent's family, returns device-bound token
4. Parent UI updates in real-time ("New device paired: Sam's MacBook")

**Why a code, not a QR or link:**
- Tauri webviews handle deep links inconsistently across OSes
- Codes work even if devices are different platforms
- Time-bounded codes prevent stale-pairing-link leaks

**Adversarial concern:** the kid intercepts the code and pairs *their friend's* device to your account. Mitigation: parent device shows a confirmation prompt with the pairing device's hostname + OS + first-seen IP before accepting. Parent has to tap "Yes, this is my child's device."

---

## "Hard lock" semantics — what can a parent actually do?

Three primitive operations a parent can perform on a child device:

### 1. Block specific apps/sites *now*, until parent unlocks
- Parent picks apps (or block lists) → "Block these on Sam's laptop now"
- Child daemon receives via WS → starts enforcing within ~2s
- Stays active until parent explicitly unlocks (no time limit)

### 2. Block on a schedule
- "Block these every weeknight 9pm–6am on Sam's laptop"
- Schedule lives in the cloud, daemon re-syncs every heartbeat
- Survives daemon restart, reinstall, account-sign-out (re-enforces on sign-in)

### 3. Emergency unblock
- Parent can unblock everything on a child device with one button
- Useful if the kid's homework site got blocked by accident at 11pm

**What we deliberately do NOT support in 1.1.0 (scope discipline):**
- Time limits per app ("2 hours of Discord per day") — Apple/Microsoft do this natively, hard to replicate well, deep feature
- Geofencing ("block when not at home") — out of scope, not core to "block apps on demand"
- Reward systems / time tokens — out of scope, behavioral-design rabbit hole

---

## Child-side anti-bypass — concrete plan

Beyond the "non-admin account" prerequisite, these are the daemon-level protections:

### Survive process kill
Already done via `ServiceWatchdogService.cs`. Watchdog restarts the daemon within 5s. Mac equivalent uses launchd's `KeepAlive`.

### Survive uninstall
- **Windows:** WiX-MSI uninstall is protected by an admin check. Without admin, can't uninstall. Parent must enter family password (via cloud verification) to allow uninstall.
- **Mac:** launchd plist owned by root, removable only with sudo. Same parent-verification requirement.
- **Both:** even if forcibly removed, parent's cloud account still has the family record. Re-installing FocusLock with the same account auto-re-applies all locks. To truly escape: kid must reinstall + use a fresh OS account never signed into the family.

### Survive clock manipulation
- Daemon uses **monotonic clock** (`Stopwatch` on Win, `mach_continuous_time` on Mac) for all enforcement timers
- Wall-clock is used only for display
- Heartbeat to cloud includes both monotonic and wall clock — cloud detects mismatch and flags suspicious devices to parent

### Survive Safe Mode (Windows)
- Register daemon with `HKLM\SYSTEM\CurrentControlSet\Control\SafeBoot\Minimal` so it starts in Safe Mode too
- Network layer doesn't load in Safe Mode → daemon falls back to last-known-good lock rules from local cache

### Survive offline
- Child daemon caches lock rules locally
- If WS drops + heartbeat fails for >5 min, daemon enters "offline mode" with the last-known rules **plus** an additional precautionary block: all-network-off, except a small allowlist (resolves to parent's emergency contact info)
- Reconnects on network return; parent sees "Sam's device was offline 12 minutes" alert

### Tamper detection
- Daemon HMAC-signs its local config files (already exists for sessions)
- Any unsigned/mismatched file → daemon refuses to start, reports tamper to cloud, falls back to "fully locked" (no internet except parent allowlist)

### What we still can't beat
- Kid with another laptop / phone — out of scope (parent buys family-wide blocking, not single-device)
- Kid with admin rights — already covered; this is the prerequisite, cannot be assumed away
- Bootable USB with another OS — needs BIOS password + Secure Boot; parent's responsibility, document it in the setup guide

---

## Audit & visibility (parent-side)

Parent dashboard shows for each child device:
- Current lock state (which apps blocked right now, why)
- Heartbeat status (online/offline, last seen)
- Recent activity: every block trigger, every override attempt by the kid, every successful unlock
- Tamper alerts (HMAC mismatch, daemon kill+restart, offline >X min)
- Browsing/app-use stats (opt-in, privacy boundary — see below)

**Privacy boundary:** parent does NOT see live browsing history or screen contents. Only **what was blocked**, not **what was visited**. This is a deliberate design choice — a kid's reasonable expectation of privacy matters, and turning FocusLock into a surveillance product changes its character entirely. If parents want surveillance, they should buy a surveillance product (Bark, Qustodio); we're a focus-and-block tool.

---

## Phased build plan

**Phase 2.1 — Cloud backend MVP** ✅ shipped 2026-05-21
- D1 schema: accounts, devices, lock_rules, audit_log
- Worker endpoints: signup, login, refresh, pair, list-devices, set-rule, get-rules
- Durable Objects: 1 DO per device, holds WS connection
- Auth middleware

**Phase 2.2 — Parent dashboard** ✅ shipped 2026-05-21
- "Family" tab in FocusLock UI gated behind `VITE_FAMILY_API_URL`
- Login + signup flow
- Device list, pairing-code generation
- Per-device block-now form + active rules + unpair
- Live device state (online dot polled every 30s)

**Phase 2.3 — Child daemon hook-up** ✅ shipped 2026-05-21
- Cloud-sync service on both daemons: WebSocket to `/api/v1/device/ws`, 60-second heartbeats (wall + monotonic), exponential reconnect (2s → 30s)
- REST snapshot pull on every reconnect so a dropped push window can't leave the cache stale
- `block_now` and `unblock_all` enforcement — rules unioned with active session blocks, applied via existing hosts file + process-kill primitives, enforced outside a session too
- Local rule cache (`family-rules.json`) survives daemon restarts
- IPC: `family_redeem_code`, `family_unpair`, `family_get_status`; redeem gated behind settings PIN when configured
- Device token + server URL persisted under ProgramData ACL (Win) / mode 0600 (mac)
- **Deferred to 2.4:** schedule-rule enforcement (cached but not yet acted on), HMAC signing of the family cache, the offline precautionary lockdown
- **Still open:** child-side UI for entering the pairing code — IPC and shared/protocol.ts types are in place, the screen itself is a separate task

**Phase 2.4 — Anti-bypass hardening** ✅ daemon-side shipped 2026-05-21
- Schedule-rule cron evaluation: minimal 5-field parser, evaluated each tick in local time, matching rules contribute to the same union as `block_now`
- Safe Mode registration on Windows: `HKLM\SYSTEM\CurrentControlSet\Control\SafeBoot\{Minimal,Network}\FocusLock` written at daemon startup
- HMAC signing of `family-rules.json` + `family.json` via a new `IntegritySigner` that reuses `daemon.key`; tampered files fail verify-on-load and are discarded
- Offline tracking + audit: `FamilyStatus.offlineSeconds`, one-shot `family_offline_5min` / `family_reconnected` audit events, pair/unpair audited too
- `family_check_environment` IPC: platform, OS version, daemon-elevation status, UAC-enabled flag
- **Carried over to 2.5:** admin-protected uninstall (needs NSIS/WiX edits — installer-side, not daemon); firewall-level offline lockdown (cross-platform deny-all-except-allowlist via netsh/pfctl, deferred as own phase); per-user admin-account enumeration in the env-probe

**Phase 2.5 — Polish + beta** ✅ daemon + UI shipped 2026-05-23
- Child-pairing UI screen — "I have a pairing code" tab on the signed-out Family view
- Parent-side env warning UI — surfaces daemon-not-elevated, UAC-off, and named local-admin accounts via the env probe
- Audit log UI on parent + child views with collapsible card, filtered to family events
- Tamper-alert notifications — daemon writes `family_cache_tampered` on signed-cache mismatch, UI polls every 60s and fires OS notifications
- Emergency unblock — per-device "Lift all family locks" / "Re-enable rules" toggle on the parent dashboard, posts an `unblock_all` rule
- Per-user admin enumeration — Windows AccountManagement + macOS dscl, surfaces the names of admin accounts in the env warning
- First-run walkthrough modal — 3-step parent vs child path, replayable from the page header
- Admin-protected uninstall — daemon writes a 15-minute authorization token via `family_authorize_uninstall`; NSIS hook checks it via PowerShell and aborts with a clear message when the settings-lock PIN is set
- Firewall-level offline lockdown — experimental Windows-only opt-in (`firewall_lockdown_enabled` flag) that adds per-EXE-path Windows Firewall outbound blocks via `FirewallLockdownService` after 5 minutes of WS downtime, with fail-open cleanup on startup + shutdown
- **Open:** closed beta with ~5 friend-families; iterate on what actually fails in real use; macOS pfctl equivalent of the firewall lockdown (flag round-trips but enforcement is a no-op there)

**Phase 2.6 — Real password-reset email** ✅ worker shipped 2026-05-22
- `family-server/src/email.ts` wraps the Resend HTTP API. Three optional env vars: `RESEND_API_KEY` (no key → falls back to `console.log` so dev/self-host still boots), `EMAIL_FROM` (override the default `onboarding@resend.dev` sandbox sender once a custom domain is verified), `RESET_URL_BASE` (override the landing URL).
- `/auth/reset-request` now actually sends a real reset link. Response stays enumeration-safe (same shape whether the email is registered or not); Resend send failures are logged to worker tail but never bubble up to the caller.
- New static `landing/reset.html` reads `?token=` from the URL, POSTs to `/auth/reset-confirm`, shows the result. Hardcoded production worker URL — forks edit it.
- Desktop UI gained a `ForgotPasswordButton` on the login form → modal → submit → "if registered, link is on its way" copy.
- **Operator step:** `wrangler secret put RESEND_API_KEY` against the prod worker. Until done, the worker logs `[reset-email] (no RESEND_API_KEY set)` and the email never actually sends. Key uploaded 2026-05-22.
- **Sandbox-sender limit:** `onboarding@resend.dev` only delivers to the email used to sign up for Resend. Verifying a custom domain in Resend (`tryfocuslock.com`) lifts this; rotate the key at the same time.

**Phase 2.9 — Login + reset-request rate limiting** ✅ shipped 2026-05-22
- New `auth_rate_limits` table (`migrations/0002_auth_rate_limits.sql`) with `key TEXT PRIMARY KEY`, attempts counter, window start, and a blocked-until timestamp. Same key used whether the email exists or not — otherwise a 429 vs 401 would leak account existence.
- `src/rateLimit.ts` module: sliding-window check + record + clear. `LOGIN_POLICY` = 5 failures in 15min → 30min block. `RESET_POLICY` = 3 failures in 60min → 60min block.
- `src/utils.ts` gains `tooManyRequests(seconds, msg)` helper that returns 429 with both a `Retry-After` header (rounded seconds, per spec) and a `retryAfterSeconds` body field (precise) so the client can render either.
- `/auth/login` and `/auth/reset-request` check before doing real work, then increment on failure or clear on success. Audit events `login_rate_limited` and `reset_rate_limited` fire the moment a key gets blocked.
- D1 read-after-write lag may shift the effective threshold up by ~1 attempt in practice — still blocks the attacker after a small finite count. Documented in `rateLimit.ts`; Durable Objects per-key would close the gap if it ever matters.
- `FamilyApiError.retryAfterSeconds` is now populated on 429s so a future UI countdown can read it; for now the user-facing message ("Too many failed attempts. Try again in 30 minutes.") is descriptive enough on its own.

**Phase 2.7 — Data portability** ✅ shipped 2026-05-22
- `GET /api/v1/account/export` returns a versioned JSON dump (`schema_version: "1.0"`) of account info, devices, lock rules, and audit log. Secrets (`password_hash`, `device_token_hash`) stripped at the HTTP layer; audit IP omitted on purpose so a shared export file isn't an accidental location-history leak.
- `DELETE /api/v1/account` requires the JWT *and* password re-entry. Audit-log rows for the account are deleted first (no FK on `audit_log`), then the account row — D1's `ON DELETE CASCADE` handles devices, pairing codes, lock rules. A forensic `account_deleted` audit row is written with `account_id = NULL` so it survives the cascade.
- New audit events: `account_data_exported`, `account_deleted`, `account_delete_failed`.
- UI: "Your data" card on the parent-signed-in view. "Export as JSON" triggers a Blob download named `focuslock-family-export-YYYY-MM-DD.json`. "Delete account" opens a danger-zone modal requiring both the password and the typed phrase `delete my account` before the destroy button enables. After success the store clears the session, dropping the user back to signed-out.
- `FamilyDataExport` wire type lives in `shared/protocol.ts` so a future import tool has something stable to type against.

**Total: ~5 weeks of focused work.** Realistic with normal life happening: 8-10 weeks.

After Phase 2.5 ships as 1.1.0:
- **Phase 3** (later, maybe never): TOTP 2FA, multi-parent families, app time limits, mobile parent app, OS-level integration (Family Safety / Screen Time APIs where available)

---

## Product decisions (locked 2026-05-21)

1. **Pricing — free in beta, paid after Phase 2.5.** ~$5/mo per family for the hosted cloud. Single-device FocusLock stays free forever. Self-hosters (running their own server) stay free forever too.

2. **Server code — open-source, same GPL-3.0 repo.** Backend lives under `server/` or `family-server/`. Anyone can audit, anyone can self-host. Consistent with FocusLock's threat model ("friction, not hiding code") and OSS values.

3. **Non-admin child account — mandatory, with auto-setup where possible.** Windows: parent onboarding calls `New-LocalUser` + `Remove-LocalGroupMember -Group Administrators` via elevated PowerShell to create the child account in one UAC prompt. Mac: walk parent through System Settings → Users with screenshots (no clean automation path on Mac since the relevant flows are GUI-only). Hard gate — parent cannot complete onboarding until a non-admin child account exists on the child device.

4. **Password recovery — email reset, instant** (no 24h delay). *Trade-off:* if a kid briefly gets parent-email access, they can reset and sign in. Document this as a known limitation in beta. Revisit if abuse pattern emerges.

5. **Mobile parent app — deferred to Phase 3+.** 1.1.0 ships desktop-only: parent controls family from their own laptop. Mobile is a real second product on top of the first — worth doing later, not in v1. Web-responsive parent UI may still happen organically (since the parent UI is React in a Tauri webview — same React code can theoretically also be served from the worker for browser access).

### Still-open operational items (not blockers for Phase 2.1)

- **Account portability:** GDPR-style "Export family data" (JSON) + "Delete account" (cascading D1 deletion). Build into the backend from day one — easier to bolt in early than late.
- **What if parent forgets password AND has no email access:** No recovery exists. We hold no backdoor. Document clearly during signup.

---

## Sequence diagram — typical "block now" flow

```
Parent UI    Cloud Worker    Durable Object    Child Daemon
   │              │                │                 │
   │ POST /lock   │                │                 │
   ├─────────────>│                │                 │
   │              │ write D1       │                 │
   │              ├────────┐       │                 │
   │              │<───────┘       │                 │
   │              │ notify DO      │                 │
   │              ├───────────────>│                 │
   │              │                │ push via WS     │
   │              │                ├────────────────>│
   │ 200 OK       │                │                 │
   │<─────────────│                │  apply rules    │
   │              │                │                 ├─┐
   │              │                │                 │ │ enforce
   │              │                │                 │<┘
   │              │                │ ack             │
   │              │                │<────────────────│
   │              │ webhook        │                 │
   │              │<───────────────│                 │
   │ WS push      │                │                 │
   │<─────────────│                │                 │
   │ "applied"    │                │                 │
```

Round-trip: ~200ms on a normal connection.

---

## Decision log (things to revisit)

- **D1 vs Postgres:** if family graph gets complex (multi-parent, multi-family, sharing), revisit. D1 may not be enough.
- **Cloudflare lock-in:** if costs balloon or DO limits hit, migrate to Fly.io + Postgres. Keep server code portable (no CF-specific APIs except where unavoidable).
- **"Hard lock" definition:** if users keep asking for time-limits or reward systems, expand the primitive set. Stay disciplined for v1.

---

## Next step

If this design is approved as-is, **Phase 2.1 starts with a D1 schema + worker scaffolding PR**. Estimated 2-3 days for that piece alone.
