# FocusLock Usage Analytics — Phase 0 Discovery

**Purpose:** grounding document for the Contract Architect (Phase 1) and every subsequent phase. Everything below is verified against the working tree at `/Users/oscarpetrikas/focus-lock`. Companion file: `/Users/oscarpetrikas/.claude/plans/ultrathink-focuslock-warm-pony.md` (multi-agent orchestration + verbatim brief).

**Verification of this doc:** paths are grep-confirmed; line numbers reflect the tree at time of writing.

---

## 1. Codebase map

### Repo layout
`/Users/oscarpetrikas/focus-lock` — monorepo. Top-level:
`ARCHITECTURE.md`, `CHANGELOG.md`, `CLAUDE.md`, `README.md`, `WALKTHROUGH-parental-controls.md`, `api/`, `daemon-mac/`, `daemon-win/`, `dashboard/`, `docs/`, `family-server/`, `installer/`, `landing/`, `scripts/`, `shared/`, `supabase/`, `ui/`, `update-server/`, `vercel.json`.

### macOS daemon (Swift, root)
`daemon-mac/`
- `Package.swift` — one `.executableTarget` "FocusLockDaemon", `.macOS(.v13)`, **zero SPM deps** (no SQLite wrapper).
- `Sources/FocusLockDaemon/main.swift` — startup wiring + 1s tick loop.
- `Sources/FocusLockDaemon/IpcSocketService.swift` — unix-socket NDJSON server, dispatch table at ~L134-L179.
- `Sources/FocusLockDaemon/Models.swift` — Codable mirrors of `shared/protocol.ts`.
- `Sources/FocusLockDaemon/SessionService.swift` — session lifecycle, HMAC signing, `session.json` + `sessions.jsonl`.
- Other services (one file each): `ProfileService`, `ScheduleService`, `CronEvaluator`, `HostsService`, `ProcessKillService`, `InterceptHttpService`, `BrowserDohPolicyService`, `ParentService`, `ParentAuditService`, `FamilyService`, `FamilyMessages`, `FamilyEnforcementService`, `CloudSyncService`, `FirewallLockdownService`, `IntegritySigner`, `CodeSignatureCheck`, `EnvironmentProbe`.
- `com.focuslock.daemon.plist` — LaunchDaemon plist (root). Only launchctl/LaunchDaemon reference in the repo.
- **No test target.** No XCTest files.

### Windows daemon (C# .NET 8, SYSTEM)
`daemon-win/FocusLock.Daemon/`
- `FocusLock.Daemon.csproj` — Worker Service. Already declares: `Microsoft.Extensions.Hosting 8.0.0`, `Microsoft.Extensions.Hosting.WindowsServices 8.0.0`, `Microsoft.Extensions.Logging.EventLog 8.0.0`, **`Microsoft.Data.Sqlite 8.0.10`** (used by `ProfileService.cs`), `System.IO.Pipes.AccessControl 5.0.0`, `System.DirectoryServices.AccountManagement 8.0.0`.
- `Program.cs`, `DaemonWorker.cs`, `IpcPipeService.cs`, `InterceptHttpService.cs`, `ServiceWatchdogService.cs`.
- `Models/`: `IpcMessage.cs`, `SessionState.cs`, `FocusProfile.cs`, `FamilyMessages.cs`.
- `Services/`: `SessionService.cs`, `ProfileService.cs` (SQLite), `HostsFileService.cs`, `ProcessKillService.cs`, `ScheduleService.cs`, `CronEvaluator.cs`, `BrowserDohPolicyService.cs`, `ParentService.cs`, `ParentAuditService.cs`, `EnvironmentProbe.cs`, `FamilyService.cs`, `FamilyEnforcementService.cs`, `CloudSyncService.cs`, `FirewallLockdownService.cs`, `IntegritySigner.cs`, `SafeModeRegistration.cs`.
- Test project: `daemon-win/FocusLock.Daemon.Tests/FocusLock.Daemon.Tests.csproj` — xUnit 2.9.0, TFM `net8.0-windows`. Existing tests: `SessionServiceEmptyPayloadTests.cs`, `HostsFileServiceStripTests.cs`, `BrowserDohPolicyServiceTests.cs`.
- **No `.sln` in the repo.** New tracker project = a sibling `.csproj`, built by `dotnet build` on its own directory.

### Shared IPC types
- `shared/protocol.ts` (403 lines) — sole source of truth. Tagged-union `IpcRequest` at L82-110; `IpcResponse` at L144-158; `ErrorCode` enum L183-187; `ParentTokenEnvelope` L114-116.
- `ui/src/types/index.ts` (30 lines) — re-exports + `CATEGORY_LABELS`.

### UI (Tauri 2 + React 18 + TS + Vite + Tailwind + Zustand)
- `ui/package.json` — dev `vite`, build `tsc && vite build`, test `vitest run`. **No chart library.** Deps: react, react-dom, react-router-dom, @tauri-apps/api, clsx, framer-motion, zustand.
- `ui/src/App.tsx` — route table L37-46.
- `ui/src/components/Nav.tsx` — sidebar. Insights link group L32-38.
- `ui/src/components/Icons.tsx` — icon set.
- `ui/src/components/ui.tsx` — shared primitives: `Page`, `Card`, `SectionHeader`, `Toggle`, `Pill`, `PageHeader`.
- `ui/src/pages/Dashboard.tsx` (693 lines) — aside grid L539-554 hosts summary cards. `GoalBar` at L77-104 is the mirror template.
- `ui/src/pages/Analytics.tsx` (373 lines) — hand-rolled `<svg>` heatmap + Framer-Motion bars. **Do not touch.**
- `ui/src/pages/Settings.tsx` (617 lines) — file-local `Section` (L15-33) + `Row` (L35-47) primitives. Appearance section L284-301 is the mirror template.
- `ui/src/stores/daemon.ts` — Zustand store. Top-level state L51-68. `request()` helper L24-33. Streaming daemon-status event listener L149.
- `ui/src/lib/parentGate.ts` — `withParentGate<T>(action: () => Promise<T>): Promise<T>` at L48.
- `ui/src/index.css` — CSS custom-property tokens (dark L27-99, light L101-165).
- `ui/tailwind.config.js` — token bindings, custom shadows, keyframes.
- `ui/src-tauri/src/lib.rs` — single `ipc_request` Tauri command. **No new Tauri command needed** for `usage.*`.

### Landing site
- `landing/` — static HTML/CSS/JS. No build step for `index.html`.
- `landing/index.html` — trust chips at **L1824** (hero-badge) and **L1842** (trust-item); FAQ mention at **L2156**. Sections: NAV / HERO / HOW / FEATURES / REVIEWS / STORY / OPEN SOURCE / FAQ / DONATE / NEWSLETTER / FINAL CTA / FOOTER.
- `landing/changelog.html` — timeline of `<article class="entry" data-type="app|web">` blocks. Web entries use `data-type="web"` + human date + **no** `.version-tag`.
- `vercel.json` — `outputDirectory: "landing"`, `buildCommand: cd dashboard && npm install && npm run build`. Landing deploys as-is; dashboard rebuilds on every deploy (side effect).

### CI
- `.github/workflows/ci.yml` — 4 gates:
  - `typecheck` (ubuntu): `cd ui && npx tsc --noEmit`
  - `rust-check` (windows): `cd ui/src-tauri && cargo check --target x86_64-pc-windows-msvc` (with placeholder `resources/FocusLockDaemon.exe`)
  - `dotnet-build` (windows): `cd daemon-win/FocusLock.Daemon && dotnet build -c Release`
  - `swift-build` (macos-14): `cd daemon-mac && swift build -c release`
- **CI runs no tests.** `vitest` and `dotnet test` are local gates only.

---

## 2. IPC envelope

Newline-delimited JSON. Transports: unix socket `/var/run/focuslock.sock` (mac), named pipe `\\.\pipe\focuslock` (win).

**Request:** `{ "type": "<command>", "payload": { ... } }`
**Response:** `{ "type": "ok"|"error"|"status"|..., "payload": {...}, "message": "...", "code": "..." }`

Adding `usage.*` messages = editing three files in lockstep (`shared/protocol.ts`, `daemon-mac/.../Models.swift`, `daemon-win/.../Models/IpcMessage.cs`) per CLAUDE.md L39. **No envelope change, no new Tauri command.**

**`session.get_current_state` does NOT exist.** `get_status` already returns `DaemonStatus.sessionActive: bool`, `DaemonStatus.session: SessionState | null`, and `DaemonStatus.pomodoroPhase`. **Recommend: tracker queries `get_status`** for in-focus tagging — no new IPC, no new lockstep edit.

---

## 3. Storage strategy

| Platform | Daemon runs as | State dir | Proposed usage DB |
|---|---|---|---|
| macOS | root | `/Library/Application Support/FocusLock/` | `/Library/Application Support/FocusLock/usage.db` (root:wheel, chmod 600) |
| Windows | SYSTEM | `%ProgramData%\FocusLock\` | `%ProgramData%\FocusLock\usage.db` |

**Multi-user (Windows).** FocusLock ships primarily to single-user Home Windows installs. Recommend a **single `usage.db` with a `user_sid` column** and defer real multi-user isolation to a later phase. If shared machines become common, we can migrate to per-user `%LOCALAPPDATA%` via impersonation without breaking the schema.

**SQLite wrappers.**
- Windows: already have `Microsoft.Data.Sqlite 8.0.10` in `.csproj`. Reuse.
- macOS: **no wrapper today.** Open question (§6 Q1): GRDB.swift vs raw `SQLite3` C API.

**Signature.** Usage data is not enforcement data — do not extend the HMAC scheme. Tampering with `usage.db` shouldn't bypass any lock; worst case a user edits their own numbers, which is fine.

**Retention pruning.** On daemon start + once per 24h. Skip when `retention_days = 'forever'`. Deletion is a hard `DELETE FROM usage_samples WHERE day < ?` — no soft delete.

---

## 4. UI integration points

- **Route:** `ui/src/App.tsx` — add `<Route path="/usage" element={<Usage />} />` at L43 between `family` and `analytics`. Import near L22.
- **Sidebar:** `ui/src/components/Nav.tsx` L32-38 — add `{ to: '/usage', label: 'Usage', Icon: Icon.??? }` inside the "Insights" group, before "Analytics". Pick an existing icon from `components/Icons.tsx` (recommend `Icon.Chart` sibling — grep to find a matching glyph).
- **Settings section:** `ui/src/pages/Settings.tsx` — mirror the file-local `Section`/`Row` primitives (L15-47) and the Appearance-section template (L284-301). Recommended placement: below "Feedback" (§6 Q7).
- **Dashboard card:** `ui/src/pages/Dashboard.tsx` L539-554 aside — mirror `GoalBar` (L77-104): `card p-4`, uppercase 11-px header, stat list, subtle bar/link.
- **State store:** `ui/src/stores/daemon.ts` L51-68 — add top-level `usageTracking: { enabled: boolean; retentionDays: 30|90|180|365|'forever'; sampleRateSeconds: number }`. Load on boot via `usage.get_settings`. Reactive selector: `useDaemon((s) => s.usageTracking)`.
- **Parent gate:** usage-tracking is user-controlled, **not** parental. Do NOT wrap `usage.enable/disable/clear_all_data` in `withParentGate`.
- **Design tokens:** all colors are `rgb(var(--x-rgb) / <alpha>)`; do not hardcode hex. Dark: `bg #0a0a0f`, `accent #6366f1`, `accent2 #8b5cf6`, `text #f8fafc`, `muted #94a3b8`. Font: Inter.
- **Chart library:** `ui/package.json` has zero chart libs. `Analytics.tsx` hand-rolls `<svg>` + Framer Motion. Adding Recharts introduces the first chart lib in the repo — **open question (§6 Q4)**.

`Section`/`Row` are file-local to `Settings.tsx`, not in `components/ui.tsx`. Phase 4 UI Engineer options: (a) duplicate locally in `Usage.tsx`, or (b) promote both into `components/ui.tsx`. Recommend (a) for the smallest diff; promotion is fine if the chart page ends up needing them.

---

## 5. Landing site — deploy path and rewrite scope

- **Site root:** `landing/`. Vercel project `focus-lock`, apex `tryfocuslock.com`, alias `focus-lock-sable.vercel.app`.
- **Deploy:** Vercel picks up on push; `vercel.json` sets `outputDirectory: "landing"`.
- **Trust-badge rewrite = three spots**, not one:
  1. `landing/index.html:1824` — hero-badge eyebrow: `Free Forever · Open Source · No Account · No Usage Tracking`
  2. `landing/index.html:1842` — trust-item chip in `.hero-trust`
  3. `landing/index.html:2156` — FAQ line ("no tracking of your focus activity")
- **Changelog entry format** (mandatory per Oscar's memory):
  ```html
  <article class="entry" data-type="web">
    <div class="entry-meta">
      <div class="entry-date">Month DD, YYYY</div>
      <span class="badge web">Web</span>
      <!-- no .version-tag for web entries -->
    </div>
    <div class="entry-body">
      <h2>Headline</h2>
      <ul><li><strong>Lead.</strong> Body sentence.</li>…</ul>
    </div>
  </article>
  ```
- **Root CHANGELOG.md** — `## vX.Y.Z — YYYY-MM-DD` heading, one-line summary paragraph, bullet list, backwards-compat footer paragraph. Or `## [Unreleased]` with `### Fixed — <summary>` subheads.

---

## 6. Open questions (surfaced to Oscar; answers unlock Phase 1)

1. **macOS SQLite wrapper.** GRDB.swift (recommended — mature, no network, active project) vs raw `SQLite3` C API (zero new dep, more boilerplate)?
2. **In-focus tagging IPC.** Reuse existing `get_status` (recommended — one fewer lockstep edit) vs add `session.get_current_state`?
3. **Windows multi-user model.** Single `usage.db` with `user_sid` column (recommended — simpler; defer real isolation) vs impersonation into `%LOCALAPPDATA%`?
4. **Chart library.** Add Recharts (recommended — Cold-Turkey IA parity is much cheaper) vs hand-roll `<svg>` matching `Analytics.tsx`'s style?
5. **macOS daemon tests.** Add a minimal `.testTarget` in `Package.swift` for `UsageStore` only vs synthetic-sender end-to-end only (matches "no test suite on mac" CLAUDE.md L33)?
6. **Self-filter.** Total-hide FocusLock UI/daemon/tracker from usage data (recommended) vs include with default-hidden UI toggle?
7. **Settings section placement.** Below "Feedback" (recommended, groups user-controls) vs above "Danger zone" vs elsewhere?
8. **Landing badge tooltip.** Proposed copy: *"Usage analytics are opt-in and stored only on your device. FocusLock never sends your app or browsing data anywhere."* — confirm?

---

## 7. Phase-by-phase file list

### Phase 1 — Contract Architect
**Create:** `docs/usage-analytics-schema.md`.
**Modify (lockstep):** `shared/protocol.ts` (add six `usage.*` messages), `daemon-mac/Sources/FocusLockDaemon/Models.swift`, `daemon-win/FocusLock.Daemon/Models/IpcMessage.cs` (and new `daemon-win/FocusLock.Daemon/Models/UsageMessages.cs`), `ui/src/stores/daemon.ts` (add `usageTracking` slice), `ui/src/types/index.ts` (re-export).
**Skeleton only:** `daemon-mac/Sources/FocusLockDaemon/UsageMigrations.swift`, `daemon-win/FocusLock.Daemon/Storage/UsageMigrations.cs`.

### Phase 2 — Daemon Engineers (parallel)
**macOS create:** `Sources/FocusLockDaemon/UsageService.swift`, `UsageStore.swift`, `UsageMigrations.swift`. **Modify:** `Package.swift` (SQLite dep — pending Q1), `IpcSocketService.swift` (register handlers), `main.swift` (retention timer).
**Windows create:** `Services/UsageService.cs`, `Storage/UsageStore.cs`, `Storage/UsageMigrations.cs`. **Modify:** `IpcPipeService.cs` (register handlers), `DaemonWorker.cs` (retention timer), `Program.cs` (DI wire-in). **No `.csproj` change** — SQLite already there.
**Tests:** `FocusLock.Daemon.Tests/UsageServiceTests.cs`, `UsageStoreRetentionTests.cs`.
**Scripts:** `scripts/usage-analytics/synth-sender-mac.sh`, `synth-sender-win.ps1`.

### Phase 3 — Tracker Engineers (parallel)
**macOS create:** new target `Sources/FocusLockUsageTracker/main.swift` inside `daemon-mac/Package.swift`. LaunchAgent plist at `daemon-mac/Resources/com.focuslock.usage-tracker.plist`. Real register/unregister replaces the Phase-2 stubs in `UsageService.swift`.
**Windows create:** new project `daemon-win/FocusLock.Tracker/FocusLock.Tracker.csproj` (sibling to `FocusLock.Daemon/`; standalone csproj since no `.sln` exists). Scheduled-Task registration in daemon `UsageService.cs` via TaskScheduler COM.

### Phase 4 — UI Engineer
**Create:** `ui/src/pages/Usage.tsx`, `ui/src/components/UsageChart.tsx`, `ui/src/components/DashboardUsageCard.tsx`.
**Modify:** `ui/src/App.tsx` (route L43), `ui/src/components/Nav.tsx` (Insights group L32-38), `ui/src/pages/Dashboard.tsx` (aside L539-554), `ui/src/pages/Settings.tsx` (new Section between Feedback and Danger zone).
**Tests:** `ui/src/pages/Usage.test.tsx`, `ui/src/components/DashboardUsageCard.test.tsx`.
**Package:** `ui/package.json` — add Recharts pending Q4.

### Phase 5 — Landing Engineer + Privacy Reviewer
**Modify:** `landing/index.html` (L1824, L1842, L2156), `landing/changelog.html` (new `data-type="web"` article), `CHANGELOG.md` (release entry), `README.md` (features list bullet), `CLAUDE.md` (one Architecture-invariant bullet). Prune dev-only logs from Phases 2-4.
**Adversarial subagent:** fresh, no history, prompt from brief §5 Phase 5 step 4.

---

## 8. Verification (Phase 0 hook)

- [x] File exists at `docs/usage-analytics-plan.md`.
- [x] Under 400 lines (`wc -l` check post-write).
- [x] Every path is grep-confirmed in `/Users/oscarpetrikas/focus-lock`.
- [x] Open questions listed (§6, 8 items).
- [x] Corrects the orchestration plan's assumptions: (a) family-controls privacy boundary lives in §9 not §7 of `docs/family-controls-design.md`; (b) `Microsoft.Data.Sqlite` already declared in `daemon-win`; (c) daemon-mac state dir is `/Library/…` (system-wide, root); (d) no `.sln`; (e) no `session.get_current_state` — reuse `get_status`; (f) trust-badge rewrite spans 3 spots in `landing/index.html`.

**Gate signal:** `Phase 0 complete. Ready for review.`
