# FocusLock — Roadmap Study (May 2026)

*Study date: 2026-05-24. Current version: **1.1.3** (CHANGELOG.md, 2026-05-23). Read-only survey of the local repo; no source files were modified.*

This is an evidence-based assessment of every component, a website review, and a prioritized roadmap. Every claim cites a path so it can be verified.

---

## Snapshot

**Desktop app (`ui/`)** — Tauri v2 + React + TypeScript, Vite frontend. Mature and feature-dense: Dashboard, Block Lists, Profiles, Schedules, Analytics, Settings, and a Family tab (`ui/src/pages/`). Recent work (1.1.3) added a full light/dark/System theme token system and a curated app-blocking picker. Command palette, achievements, onboarding, focus intentions, daily goals all present. Rust shell is thin — just `ui/src-tauri/src/lib.rs` + `main.rs` (IPC bridge + tray).

**Windows daemon (`daemon-win/FocusLock.Daemon/`)** — C# .NET 8 Worker Service, the privileged enforcer. Well-structured DI in `Program.cs` wiring 14 services: hosts-file blocking, 2s process-kill loop, schedule/cron engine, intercept HTTP server (port 80), parent-PIN gating + audit, integrity signer, and the full family-controls stack (cloud WS sync, family enforcement, firewall lockdown, Safe-Mode registration, service watchdog). This is the most code-heavy and security-critical component.

**macOS daemon (`daemon-mac/`)** — Swift SPM package, intended at parity with Windows. Same service set (`Sources/FocusLockDaemon/`). 1.1.3 fixed real macOS app-blocking (NSWorkspace bundle-ID matching). Validated **only in CI** (`swift build -c release`); no local dev machine can catch breakage — a known repeat source of broken releases (1.1.0/1.1.1).

**Website (`landing/`)** — Single large static `index.html` (3068 lines) plus `changelog.html`, `privacy.html`, `terms.html`, `reset.html`. Polished, well-designed marketing site with hero, how-it-works, 13 feature cards, live reviews (Supabase-backed), founder story, open-source pitch, FAQ, Ko-fi donate, newsletter. OS-aware download buttons via `api/download.js`.

**Backends:**
- `api/` — Vercel serverless functions: `download.js` (latest-release asset resolver), `get-reviews.js` / `submit-review.js` (Supabase reviews), `subscribe.js` (newsletter).
- `family-server/` — Cloudflare Worker + D1 + Durable Objects. Account auth (JWT), device pairing, lock-rule CRUD, child WS push. Email reset via Resend, per-email login/reset rate limiting, data export + account deletion. Reports `version: '0.2.0'` (`family-server/src/index.ts:15`).
- `update-server/` — Cloudflare Worker translating GitHub Releases → Tauri update manifest (`update-server/src/index.ts`).

---

## Strengths (don't disturb)

- **Anti-tamper primitives are genuinely thoughtful.** HMAC-signed session state, signed family caches with `.sig` sidecars and a `family_cache_tampered` audit event, SHA-256 unlock-token hashing (raw token never stored). See `ARCHITECTURE.md` and `FamilyEnforcementService.cs` `LoadCache()`/`SaveCache()`.
- **The 1.1.3 process-kill safety work is solid and should not be touched casually.** Both daemons have a protected-name denylist + interactive-session/uid filter (`ProcessKillService.cs:19-26,66-72`; `ProcessKillService.swift:13-23,114-137`). This fixed a CRITICAL bug where blocking `explorer.exe` would kill the shell. The macOS three-bucket matcher (path / bundle-id / ps-name) is the right design.
- **Family-server auth hygiene is above average for a solo project.** Rate-limit-before-DB-lookup to prevent 429-vs-401 enumeration, constant-time password compare, time-equalized no-such-account branch, distinct JWT `kind` claims per auth path (`auth.ts:60-95`, `crypto.ts:59-83`, `pairing.ts:42-46`). The reasoning is documented inline in `rateLimit.ts`.
- **Honesty about the threat model is a real product asset.** `docs/family-controls-design.md:29-42` and the in-app onboarding state plainly that a kid-with-admin defeats everything. Keep this stance.
- **Update-server design is correct** — fetches the actual `.sig` content (not a URL), 204 on no-update, semver gate (`update-server/src/index.ts:96-121`). Auto-update has been historically painful (CHANGELOG 1.0.14/1.0.23) but the server logic itself is sound.

---

## Gaps & risks

### Security / robustness

1. **Session timer trusts the wall clock — clock rollback/advance bypasses even Hardcore Mode (both platforms).**
   `EndTime` is an absolute wall-clock timestamp set at start and signed; expiry is `DateTime.UtcNow < EndTime`.
   - Windows: `Models/SessionState.cs:35,38` (`IsActive => DateTime.UtcNow < EndTime`, `Remaining => EndTime - DateTime.UtcNow`); `SessionService.cs:192-193` (start), `:283-286` (`Tick()` finalizes the instant `now >= EndTime`).
   - macOS: `SessionService.swift:171-172` (start), `:227` (expiry), with `Date()`/`timeIntervalSinceNow` throughout.
   **Impact:** A user (or child) who sets the system clock forward past `EndTime` ends the session immediately — the *one* thing Hardcore Mode promises ("not you, not a reinstall," per landing `index.html:1918`) is broken. `docs/family-controls-design.md:36` explicitly listed "Change system clock → daemon uses monotonic clock (small change)" as a planned mitigation; it was never implemented for the session timer. (Heartbeats use a monotonic clock per CHANGELOG 1.1.0, but the timer that actually governs blocking does not.)

2. **`/api/v1/family/pair/redeem` has no rate limiting.**
   1.1.2 added per-email limits to `/auth/login` and `/auth/reset-request` only (`rateLimit.ts`, wired in `auth.ts`). `pairRedeem` is wired straight through in `index.ts:30` with no throttle, and `consumePairingCode` (`db.ts:154-174`) has no per-IP guard. The codes are 6 digits (1M space) with a 10-minute TTL (`db.ts:133`). An attacker spraying codes could pair their own device onto a stranger's family account. Low probability per-code, but it's an unauthenticated, brute-forceable endpoint that controls what gets enforced on a child's machine. Flagged in `docs/family-controls-status.md:102` and still open.

3. **Signup still leaks account existence via `409 Conflict`** (`auth.ts:44-46`). Known and documented as acceptable-in-beta (`family-controls-status.md:100`), but worth closing before GA since the rest of the auth surface is careful about enumeration.

### Cross-platform / test coverage

4. **Zero automated tests anywhere in the repo.** The only file matching `*test*`/`*spec*` is a vendored DLL. CI (`.github/workflows/ci.yml`) runs `tsc --noEmit`, `cargo check`, `dotnet build`, and `swift build` — compile checks only, no `dotnet test` / `swift test` / Vitest. Given (a) the macOS daemon can't be run on the Windows dev box and (b) the family-server is security-critical with subtle enumeration/rate-limit logic, the absence of even a handful of unit tests is the single biggest structural risk. `family-controls-status.md:104` already flags "No tests yet" for the Worker.

5. **Win/Mac parity is maintained by hand and by hope.** The kill loop, family enforcement, cron evaluator, parent service, integrity signer, and firewall lockdown all exist twice (C# + Swift) with no shared test vectors. A cron edge case or signing-format drift between the two implementations would not be caught by CI.

### Stale docs / dead comments (cheap to fix, currently misleading)

6. **`FamilyEnforcementService.cs:12-18` claims schedule cron is "deferred to Phase 2.4 ... we just don't react yet"** — but the code *does* evaluate cron (`:72`, `:94-95`, `RebuildCronLocked` at `:185-196`), and CHANGELOG 1.1.0 shipped it. The comment is stale and will mislead the next reader into thinking a shipped feature is a stub.

7. **`shared/protocol.ts:233-234` says "macOS daemon stores but does not enforce the [firewall] flag yet"** — but `FirewallLockdownService.swift` fully implements pfctl-based enforcement (anchor at `:34`, apply at `:132-135`, 10s timeout at `:227`). Stale comment; macOS enforces (IP-based, not per-process — that nuance is worth keeping, the "does not enforce" claim is not).

8. **`docs/family-controls-status.md` is a pre-1.1.0 snapshot (dated 2026-05-21)** that lists Phases 2.3–2.5 as "⏭️ does not exist yet." All of it shipped in 1.1.0–1.1.3. Anyone picking up the project from this doc would re-investigate already-done work. Either update it to reflect shipped state or mark it superseded.

9. **`ProcessKillService.cs:58-59`** — a dangling comment about a Pomodoro break-allowlist that is "not implemented here." Minor, but it reads like an unfinished thought; clarify or remove.

### Other

10. **GitHub repo slug casing is inconsistent.** UI uses `Relevant47/focus-lock` (lowercase: `Settings.tsx:514,548-549`; `privacy.html:54,69`); landing page and `api/download.js:1` use `Relevant47/Focus-lock` (capital F: `index.html:1797,1819,2146,2260`). GitHub is case-insensitive so it works today, but README.md:74-77 declares lowercase canonical. One typo away from a broken link on a rename.

11. **`api/submit-review.js` auto-approves any 4-5 star review ≥40 chars with no rate limiting** (`:31-33`). Combined with no auth, this is a fake-review injection vector on the public landing page — easy to seed glowing reviews or, with a tweak, get spam past the wordlist.

---

## Website findings (`landing/`)

1. **Privacy policy is now materially inaccurate and contradicts itself on children's data.** `privacy.html:34` says "FocusLock collects nothing... Everything stays on your device. The only external request is to check for software updates," and `:62-63` says it "does not knowingly collect any information from anyone, including children." Since v1.1.0, **Family Controls creates a cloud account (email + password) and stores child device hostnames, OS, IP addresses, and audit logs** in the `family-server` D1 database (`family-server/migrations/0001_initial_schema.sql`, `db.ts` device/audit inserts). The privacy policy never mentions the family-server. For a trust-first OSS app that explicitly handles children's data, this is the **highest-priority website fix** — it's a credibility and arguably legal exposure, not just a copy nit. (The opt-in/self-host nature should be stated, but the policy must describe what the hosted family backend stores.)

2. **Family Controls — the entire 1.1.x flagship — is absent from the landing page.** The 13 feature cards (`index.html:1906-1992`) stop at single-device tools; no "parental/family controls" section, and a content-level search finds zero mentions of family/parent/child outside CSS. The biggest feature of the last month isn't sold anywhere on the site. Either add a section or make a deliberate decision to keep it beta-only (note it in Open Questions).

3. **"Built to be unbypassable" headline (`index.html:1903`) conflicts with the project's own honesty stance** and with finding #1 above (clock-rollback). The in-app and design-doc messaging is carefully "friction, not a perfect cage." The landing headline overpromises. Recommend softening to something like "Built to be hard to bypass" / "Serious enforcement, honestly explained."

4. **No social-share image.** No `og:image`, `twitter:image`, or `twitter:card` meta (only `og:title`/`og:description` at `index.html:8-9`). The maker actively shares on Instagram/TikTok (`:2104-2112`); every share currently renders with no preview card, directly costing reach for a growth-dependent free app. Adding an OG image is ~30 min and high ROI.

5. **No web analytics of any kind.** No gtag/Plausible/Umami in `index.html`. Consistent with the privacy ethos, but it means there is **zero visibility into download conversion** for a project whose whole growth model is the landing page. A privacy-friendly, cookieless option (Plausible/Umami, ideally self-hosted) would let the maker actually measure what's working. (If kept analytics-free, that's a fine principled choice — but make it a conscious one.)

6. **`changelog.html` is stale — stops at v1.1.0** (`changelog.html:235`), missing 1.1.1, 1.1.2, and the CRITICAL 1.1.3 daemon-safety release. A visitor checking "is this maintained?" sees a 3-version-old changelog. Either keep it in sync or generate it from `CHANGELOG.md`.

7. **No `rel="canonical"` tag** — minor SEO hygiene for when the site is served from multiple hosts (Vercel preview URLs, Netlify, etc.).

---

## Recommendations

### Quick wins (do first)

| Rec | Why it matters | Effort | Impact |
|-----|----------------|--------|--------|
| Rewrite `privacy.html` to disclose the family-server (account, child device data, IP, audit) and fix the contradictory children's-privacy clause | Trust/legal exposure on a children's-data product whose pitch is "audit it yourself" | S | High |
| Update `changelog.html` to 1.1.3 (or auto-generate from `CHANGELOG.md`) | "Is this maintained?" signal; currently looks 3 versions stale | S | Med |
| Add `og:image` + `twitter:card` meta to `index.html` | Every social share currently has no preview; direct reach loss | S | Med |
| Fix stale comments: `FamilyEnforcementService.cs:12-18`, `protocol.ts:233-234`, `ProcessKillService.cs:58` | They describe shipped features as stubs — actively misleading | S | Low |
| Normalize repo slug to `Relevant47/focus-lock` everywhere (`index.html`, `api/download.js:1`) | Removes a rename-fragile inconsistency | S | Low |
| Mark `docs/family-controls-status.md` as superseded or update phase table | Prevents re-investigating done work | S | Low |

### Bigger bets

| Rec | Why it matters | Effort | Impact |
|-----|----------------|--------|--------|
| **Make the session timer monotonic-clock-aware** (detect clock jumps; anchor remaining time to a monotonic source, persist boot-relative or recompute on suspicious deltas) | Closes the clock-rollback bypass that breaks Hardcore Mode's core promise — on both platforms | M | High |
| **Add a minimal automated-test layer**: Vitest + miniflare for `family-server` (auth enumeration, rate-limit ladder, pairing race), shared cron-vector tests run against both daemons, `dotnet test` + `swift test` in CI | Only structural defense against the recurring macOS-breakage and against subtle auth/rate-limit regressions; the dev box can't run the Swift daemon | M–L | High |
| **Rate-limit `/pair/redeem`** (reuse the `rateLimit.ts` pattern, key by IP and/or code) | Closes an unauthenticated brute-forceable endpoint that controls a child's enforcement | S–M | Med |
| **Add a Family Controls section to the landing page** (or consciously gate it as beta-only) | The flagship feature of the last month is invisible to visitors | M | Med |
| Add privacy-friendly, cookieless analytics (or decide explicitly to stay analytics-free) | Currently flying blind on the only growth surface | S | Med |

### Watch / tech debt

- **macOS daemon validated only in CI** — biggest ongoing release risk. Mitigated only by the test layer above; until then, treat every macOS-touching change as unverified. (Memory: this already cost 1.1.0/1.1.1.)
- **Hand-maintained Win/Mac parity** across ~8 duplicated services — drift is invisible without shared test vectors.
- **`submit-review.js`** auto-approval + no rate limit — low urgency, but a fake-review/spam vector on a public page.
- **Signup `409` enumeration** — fine for beta, close before GA (tie to email-verification work).
- **PBKDF2 at 100k iterations** (`crypto.ts:9`) — capped by the Workers `deriveBits` limit, documented, and the hash format is versioned so it can be upgraded later. Acceptable now; revisit if Workers raises the cap or if moving auth off the Worker.

---

## Open questions (need maintainer input)

1. **Is Family Controls meant to be public-facing yet?** It's described as a closed beta (CHANGELOG 1.1.0, `docs/family-controls-beta.md`), which would explain its absence from the landing page — but the privacy-policy gap exists *regardless* of marketing, because shipped 1.1.x builds can talk to the hosted backend. At minimum the privacy policy must catch up even if marketing waits.
2. **What's the canonical clock-trust stance for Hardcore Mode?** Is the wall-clock dependency a known accepted limitation, or a bug to fix? It directly undercuts the "unbreakable" framing, so the answer drives both an engineering fix (monotonic timer) and a marketing-copy change.
3. **Analytics: principled zero, or worth a cookieless tool?** The privacy policy currently promises "no analytics... you can verify this yourself" — adding even Plausible would require updating that promise. This is a values call, not just a tooling one.
4. **Stay analytics-free + telemetry-free at the cost of never seeing crash/conversion data?** Same trade-off as #3 but for the app itself; relevant if release-quality issues keep recurring.
5. **Family-server cost/scaling plan past beta** (`family-controls-status.md` notes ~$5/mo/family for hosted). Not urgent technically, but the data-handling and privacy-policy work should be done *before* onboarding paying families with children's data.
