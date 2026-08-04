# FocusLock Usage Analytics — Contract (Phase 1)

Companion to `docs/usage-analytics-plan.md`. This file is the **consumable
reference** for Phases 2–5. Every downstream engineer reads this before
touching a keyboard.

**Scope of Phase 1:** types, DDL, IPC surface, and store skeleton. **Nothing
runs at runtime yet.** Phase 2 wires handlers to storage; Phase 3 ships the
tracker; Phase 4 builds the UI.

**Non-negotiables (from the master brief §2):**
- No network calls for usage data. Ever.
- Off by default.
- Never carried through family-server pairing IPC.
- No `family` or `parent` token in any `usage.*` payload.

---

## 1. Data model

### DDL (v1)

```sql
CREATE TABLE IF NOT EXISTS usage_samples (
    day TEXT NOT NULL,                        -- YYYY-MM-DD, local tz (see §1.1)
    user_sid TEXT NOT NULL DEFAULT '',        -- Windows SID; '' on macOS
    bundle_id TEXT NOT NULL,                  -- macOS bundle id or Win exe path
    app_name TEXT NOT NULL,                   -- product-facing name only (mac: localizedName; win: FileDescription) — NEVER window title
    seconds INTEGER NOT NULL,                 -- total = in_focus + out_focus
    in_focus_seconds INTEGER NOT NULL,        -- captured while sessionActive
    out_focus_seconds INTEGER NOT NULL,       -- captured while !sessionActive
    PRIMARY KEY (day, user_sid, bundle_id)
);
CREATE INDEX IF NOT EXISTS idx_usage_day ON usage_samples(day);

CREATE TABLE IF NOT EXISTS usage_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
```

The DDL string is copy-pasted **verbatim** into:
- `daemon-mac/Sources/FocusLockDaemon/UsageMigrations.swift` (`UsageMigrations.v1`)
- `daemon-win/FocusLock.Daemon/Storage/UsageMigrations.cs` (`UsageMigrations.V1`)

Any change here is a lockstep edit across three files (this doc + both
migration constants). Bump to `v2` rather than editing `v1` after v1.4.x ships.

### 1.1 Why day-aggregated, not per-tick

Storing every 5-second tick would balloon the DB (~17k rows/day per active
app). Aggregating by `(day, user_sid, bundle_id)` gives us:
- `O(active_apps_per_day)` rows — realistically <500/day even for heavy users.
- Cheap range queries: the index on `day` matches the Usage page's daily
  breakdown grid without further indexing.
- Trivial retention prune: `DELETE FROM usage_samples WHERE day < ?`.

The tracker posts individual samples via `usage.report_sample`; the daemon
performs the upsert (`INSERT ... ON CONFLICT(day, user_sid, bundle_id) DO
UPDATE SET seconds = seconds + excluded.seconds, ...`).

**Days are in the daemon process's local timezone.** The tracker sends UTC
ISO-8601 timestamps on the wire; the daemon buckets each sample into the
local day at write time using `Calendar.current` (Swift) / `.ToLocalTime()`
(C#). Rationale: this is a user-facing personal-analytics feature and
matches the consumer convention (Cold Turkey App Statistics, macOS Screen
Time, RescueTime — all bucket to local day). Tradeoff: users who cross
timezones will see the boundary of a travel day shift by the offset
between departure and arrival zones. Acceptable for v1 — the DB stores
what the user perceives as "yesterday" rather than what UTC says.

### 1.2 Why the PK is `(day, user_sid, bundle_id)`

- `day` first — most queries scan a date range and prefix-match the PK.
- `user_sid` second — on Windows the same physical DB serves multiple users
  (per Q3 answer). On macOS `user_sid = ''` and the composite still resolves
  to one row per bundle per day.
- `bundle_id` last — high-cardinality within a day/user.

This ordering keeps the PK usable for the two hot queries (§2.3):
`WHERE day BETWEEN ? AND ?` and `WHERE day BETWEEN ? AND ? AND user_sid = ?`.

### 1.3 `usage_meta` seed keys

Phase 2's `usage.enable` handler is responsible for seeding these on first
call (INSERT OR IGNORE). Phase 1 does not touch runtime.

| key                  | initial value                                | mutable via                |
|----------------------|----------------------------------------------|----------------------------|
| `schema_version`     | `'1'`                                        | migration bumps only       |
| `retention_days`     | `'90'`                                       | `usage.set_settings`       |
| `sample_rate_seconds`| `'5'`                                        | `usage.set_settings`       |
| `enabled_at_utc`     | ISO-8601 timestamp of first enable           | `usage.enable`/`.disable`  |
| `enabled`            | `'1'` on enable, `'0'` on disable            | `usage.enable`/`.disable`  |

`enabled_at_utc` is cleared to `''` on `usage.disable`, and rewritten on the
next `usage.enable` — the value users see in Settings represents the current
enable streak, not the first-ever enable.

---

## 2. IPC contract

Seven request types, all under the `usage.*` namespace. No parent-token
envelope on any of them (they are user-controlled, not gated). No new
`ErrorCode` variants — the daemon should reuse standard `{ type: "error",
message }` for invalid payloads, unknown SIDs, etc.

### 2.1 Requests

| Type                    | Payload                       | Response                                  |
|-------------------------|-------------------------------|-------------------------------------------|
| `usage.enable`          | *(none)*                      | `{ type: "ok" }`                          |
| `usage.disable`         | *(none)*                      | `{ type: "ok" }`                          |
| `usage.report_sample`   | `UsageReportSamplePayload`    | `{ type: "ok" }`                          |
| `usage.query`           | `UsageQueryPayload`           | `{ type: "usage_query_result", payload }` |
| `usage.get_settings`    | *(none)*                      | `{ type: "usage_settings", payload }`     |
| `usage.set_settings`    | `UsageSetSettingsPayload`     | `{ type: "ok" }`                          |
| `usage.clear_all_data`  | *(none)*                      | `{ type: "ok" }`                          |

### 2.2 Response-variant decision

Existing IpcResponse variants (`profiles`, `logs`, `schedules`, `parent_token`,
`family_status`, `request_unblock_result`, `request_status_result`, etc.) each
carry a **typed payload under a dedicated `type`**. We follow that idiom
rather than folding into `{ type: "ok", payload: any }`:

- `usage.get_settings` → `{ type: "usage_settings", payload: UsageGetSettingsResult }`
- `usage.query` → `{ type: "usage_query_result", payload: UsageQueryResult }`

Mutating commands (`enable`, `disable`, `report_sample`, `set_settings`,
`clear_all_data`) resolve to plain `{ type: "ok" }`. This matches the rest of
the protocol and keeps the UI's response-narrowing pattern uniform.

### 2.3 Payload shapes

Full definitions live in `shared/protocol.ts` (source of truth). Summary:

```ts
UsageReportSamplePayload = { bundle_id; app_name; seconds; in_focus; timestamp }
UsageQueryPayload        = { start_date; end_date; top_n?; include_apps?; split_by_focus }
UsageQueryRow            = { day; bundle_id; app_name; seconds; in_focus_seconds; out_focus_seconds }
UsageQueryResult         = { rows; other_apps_total_seconds? }
UsageSetSettingsPayload  = { retention_days?; sample_rate_seconds? }
UsageGetSettingsResult   = { enabled; retention_days; sample_rate_seconds; enabled_at_utc }
```

**Field-naming note.** All `usage.*` payloads use `snake_case` (matches SQLite
column names, avoids a mapping layer in the daemons). The rest of the
protocol uses `camelCase` — this is a deliberate scoped exception.
`Models.swift` mirrors the field names directly; `UsageMessages.cs` uses
`[JsonPropertyName]` attributes to translate. Do not "harmonize."

### 2.4 Retention values

`retention_days` is a discriminated string union: `'30' | '90' | '180' | '365'
| 'forever'`. Wire format is a string (not an int) so `'forever'` round-trips.
On the daemon side, `'forever'` disables the prune entirely.

### 2.5 `top_n` and `include_apps` semantics

`top_n` selects the **N unique apps with the highest total seconds across the
range**, then returns **all** of their `(day, bundle_id)` rows. Applying
`LIMIT N` directly to the grouped rows would truncate to the N busiest single
app-days across the whole range — over a week that is typically ~all one
day's data, leaving 6/7 columns of the Usage chart empty.

When `include_apps` is set (non-empty), the query is restricted to those
bundle ids. `top_n` still applies within the filtered set. The
`other_apps_total_seconds` roll-up only appears when `top_n` truncated the
result (never when `include_apps` did).

### 2.6 No new ErrorCode

Phase 1 does not add to the `ErrorCode` union. Bad payloads → plain `{ type:
"error", message: "..." }`. If Phase 2 discovers a case needing a typed code
(e.g. "tracker not registered"), add it in Phase 2 with a lockstep DDL/model
edit — do not front-load it here.

---

## 3. Zustand store additions

`ui/src/stores/daemon.ts` gains one state slice and six action methods.

### 3.1 State slice

```ts
usageTracking: {
  enabled: boolean;
  retention_days: 30 | 90 | 180 | 365 | 'forever';
  sample_rate_seconds: number;
  enabled_at_utc: string | null;
  loaded: boolean;
};
```

Initial value: `{ enabled: false, retention_days: 90, sample_rate_seconds: 5,
enabled_at_utc: null, loaded: false }`.

`loaded` gates UI: the Usage page can distinguish "haven't fetched settings
yet" (spinner) from "confirmed disabled" (opt-in card). Phase 4's boot flow
should call `loadUsageSettings()` after `init()`.

### 3.2 Action methods

None of these wrap `withParentGate` — usage tracking is user-controlled.

- `loadUsageSettings()` — `usage.get_settings` → hydrate slice + `loaded: true`.
- `enableUsage()` — `usage.enable` → `loadUsageSettings()`.
- `disableUsage()` — `usage.disable` → reset slice to defaults locally.
- `setUsageSettings(patch)` — `usage.set_settings` → `loadUsageSettings()`.
- `clearAllUsageData()` — `usage.clear_all_data` → `loadUsageSettings()`.
- `queryUsage(params)` — `usage.query` → returns `UsageQueryResult` (transient;
  callers hold it in local component state).

---

## 4. Migration plan

- **v1** is the schema shipped in the first release with usage tracking.
- Version tracked in `usage_meta.schema_version` (`'1'` initially).
- Future migrations: add a `v2` constant, run it inside a transaction if
  `schema_version < '2'`, then update the meta row. Do NOT edit the `v1`
  constant after v1.4.x ships — that breaks users mid-upgrade.
- Migrations run inside a single transaction. Both daemons: read
  `schema_version` → apply the diff → update `schema_version` → commit.
- On first ever enable, `schema_version` does not exist yet — treat it as
  `'0'` and apply `v1`.

---

## 5. Storage locations

| Platform | Path                                    | Owner        |
|----------|-----------------------------------------|--------------|
| macOS    | `/Library/Application Support/FocusLock/usage.db` | root:wheel, 0600 |
| Windows  | `%ProgramData%\FocusLock\usage.db`      | SYSTEM       |

Multi-user (Q3): one physical DB per machine; row-level `user_sid` gives
per-user views. Migration to per-user DBs (if ever needed) is a schema-compatible
sharding change.

---

## 6. Phase 2 handoff checklist

- [ ] Execute `UsageMigrations.v1` on first `usage.enable` (idempotent DDL).
- [ ] Seed `usage_meta` rows per §1.3 on first enable.
- [ ] Register the seven `usage.*` handlers in both daemons' dispatchers.
- [ ] Wire retention prune on daemon start + 24h timer (skip when `'forever'`).
- [ ] Reuse `get_status` for in-focus tagging (Q2 answer — do not add a new IPC).
- [ ] macOS: build `UsageDB.swift` with raw `SQLite3` (Q1 answer — no GRDB).
- [ ] Windows: use existing `Microsoft.Data.Sqlite` (already in `.csproj`).
- [ ] Verify `snake_case` field names round-trip on both platforms.
