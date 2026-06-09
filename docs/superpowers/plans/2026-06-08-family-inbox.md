# Family Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the deferred "email weekly recap" idea with an **in-app Family Inbox** — a chronological feed inside the Family tab where the parent sees weekly digests and "new device paired" cards. The plumbing (table, REST endpoints, scheduled cron, UI feed, Nav badge) is the foundation later approval-request work plugs into without rework.

**Architecture:**
- **D1:** new `notifications` table keyed on `account_id`, with `kind`, `title`, `body`, `payload`, `read_at`, `created_at`.
- **Worker:** REST endpoints (`GET /api/v1/notifications`, `POST /:id/read`, `POST /read-all`) plus a `scheduled` handler that runs every Monday 14:00 UTC, aggregates the last 7 days of `audit_log` per account, and inserts one `weekly_digest` row each. `pairRedeem` writes a `device_paired` row.
- **UI:** new `<FamilyInbox />` rendered above `<DeviceCard>` in `SignedInView`. Polls every 60s. Renders cards by kind, supports per-card and bulk mark-read, and feeds an unread-count badge into the existing Nav `Family` link.
- **Out of scope (separate future plan):** approval requests (`kid_request_unblock`) — they require child-side request creation; this plan lays the inbox foundation only. Tamper-event mirroring from child to inbox is also deferred since it needs a new device→server upload endpoint.

**Tech Stack:** Cloudflare Worker (TypeScript), D1 (SQLite), Durable Objects (existing, untouched), React 18 + Zustand, Tauri 2.

---

## File Structure

**Created:**
- `family-server/migrations/0004_notifications.sql` — schema for `notifications` table.
- `family-server/src/notifications.ts` — helpers and HTTP handlers.
- `family-server/src/digest.ts` — weekly aggregation logic invoked from the `scheduled` handler.
- `ui/src/components/FamilyInbox.tsx` — feed component rendered inside `SignedInView`.

**Modified:**
- `family-server/wrangler.toml` — add `[triggers]` block for the weekly cron.
- `family-server/src/types.ts` — add `NotificationRow`, `Notification`, `WeeklyDigestPayload` types and extend `Env` if needed.
- `family-server/src/db.ts` — add notification DB helpers (kept here vs. notifications.ts to mirror existing convention: row I/O in db.ts, handlers elsewhere).
- `family-server/src/pairing.ts` — write a `device_paired` notification when `pairRedeem` succeeds.
- `family-server/src/index.ts` — register the new routes and export `scheduled` from `default`.
- `ui/src/lib/familyApi.ts` — add `notifications.list / markRead / markAllRead` client methods and `Notification` type.
- `ui/src/stores/family.ts` — extend state with `notifications`, `unreadCount`, polling action.
- `ui/src/pages/Family.tsx` — render `<FamilyInbox />` inside `SignedInView`, above the devices section.
- `ui/src/components/Nav.tsx` — render an unread-count pill on the Family `NavLink`.
- `ui/package.json` + `ui/src-tauri/tauri.conf.json` — bump version to `1.3.0`.
- `landing/changelog.html` — add a `1.3.0` entry above the existing `1.2.1` entry.

---

### Task 1: Add notifications table migration

**Files:**
- Create: `family-server/migrations/0004_notifications.sql`

- [ ] **Step 1: Write the migration**

`family-server/migrations/0004_notifications.sql`:

```sql
-- Phase 3.1: Family Inbox.
-- One row per per-account notification surfaced in the Family tab feed.
-- `kind` is a discriminator (currently 'weekly_digest' | 'device_paired';
-- approval requests will add 'kid_request_unblock' later).
-- `payload` is JSON, shape depends on kind.
-- `read_at` NULL = unread.

CREATE TABLE notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  payload     TEXT,
  read_at     TEXT,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

-- The hot query is "give me this account's recent notifications, unread
-- first." Index covers both the account-scope filter and the ORDER BY.
CREATE INDEX idx_notifications_account_unread
  ON notifications(account_id, read_at, created_at DESC);
```

- [ ] **Step 2: Apply the migration locally and verify**

Run from `family-server/`:

```bash
npm run db:migrate:local
npx wrangler d1 execute focuslock-family --local \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name='notifications';"
```

Expected: a result row showing `"name": "notifications"`.

- [ ] **Step 3: Commit**

```bash
git add family-server/migrations/0004_notifications.sql
git commit -m "feat(family-server): notifications table for in-app inbox"
```

---

### Task 2: Add notification types

**Files:**
- Modify: `family-server/src/types.ts`

- [ ] **Step 1: Append the new types**

Add to `family-server/src/types.ts` (after the existing `RateLimitRow` and before the `// ── API shapes` divider):

```typescript
export interface NotificationRow {
  id: number;
  account_id: string;
  kind: 'weekly_digest' | 'device_paired';
  title: string;
  body: string;
  payload: string | null;
  read_at: string | null;
  created_at: string;
}
```

And in the API-shapes section (after `LockRule`):

```typescript
export interface Notification {
  id: number;
  kind: 'weekly_digest' | 'device_paired';
  title: string;
  body: string;
  payload: unknown;
  readAt: string | null;
  createdAt: string;
}

export interface WeeklyDigestPayload {
  periodStartIso: string;          // start of the 7-day window
  periodEndIso:   string;          // end (= digest run time)
  ruleCreates:    number;          // count of rule_create events in window
  topApps:        string[];        // up to 5 most-frequent target apps
  topDomains:     string[];        // up to 5 most-frequent target domains
  activeDeviceCount: number;       // devices seen online at least once in window
}

export interface DevicePairedPayload {
  deviceId:   string;
  hostname:   string | null;
  os:         'windows' | 'macos';
  osVersion:  string | null;
  pairedAt:   string;
}
```

- [ ] **Step 2: Verify the file still type-checks**

Run from `family-server/`:

```bash
npx tsc --noEmit
```

Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add family-server/src/types.ts
git commit -m "feat(family-server): notification types"
```

---

### Task 3: Add notification DB helpers

**Files:**
- Modify: `family-server/src/db.ts`

- [ ] **Step 1: Add helpers at the end of `db.ts`**

Append to `family-server/src/db.ts`:

```typescript
// ── notifications (Family Inbox) ───────────────────────────────────────────

export async function createNotification(
  db: D1Database,
  accountId: string,
  kind: 'weekly_digest' | 'device_paired',
  title: string,
  body: string,
  payload: unknown,
): Promise<NotificationRow> {
  const now = new Date().toISOString();
  const payloadJson = payload == null ? null : JSON.stringify(payload);
  const res = await db.prepare(
    `INSERT INTO notifications (account_id, kind, title, body, payload, read_at, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)
     RETURNING *`,
  ).bind(accountId, kind, title, body, payloadJson, now).first();
  return res as unknown as NotificationRow;
}

export async function listNotificationsForAccount(
  db: D1Database,
  accountId: string,
  limit = 50,
): Promise<NotificationRow[]> {
  // Unread first (NULL sorts last in SQLite ASC, so we use IS NULL DESC),
  // then newest first within each group.
  const res = await db.prepare(
    `SELECT * FROM notifications
     WHERE account_id = ?
     ORDER BY (read_at IS NULL) DESC, created_at DESC
     LIMIT ?`,
  ).bind(accountId, limit).all();
  return (res.results ?? []) as unknown as NotificationRow[];
}

export async function countUnreadNotifications(
  db: D1Database,
  accountId: string,
): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM notifications
     WHERE account_id = ? AND read_at IS NULL`,
  ).bind(accountId).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function markNotificationRead(
  db: D1Database,
  notificationId: number,
  accountId: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const res = await db.prepare(
    `UPDATE notifications SET read_at = ?
     WHERE id = ? AND account_id = ? AND read_at IS NULL`,
  ).bind(now, notificationId, accountId).run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function markAllNotificationsRead(
  db: D1Database,
  accountId: string,
): Promise<number> {
  const now = new Date().toISOString();
  const res = await db.prepare(
    `UPDATE notifications SET read_at = ?
     WHERE account_id = ? AND read_at IS NULL`,
  ).bind(now, accountId).run();
  return res.meta?.changes ?? 0;
}
```

Add `NotificationRow` to the existing top-of-file import from `./types`:

```typescript
import type {
  AccountRow, AuditLogRow, DeviceRow, LockRule, LockRuleRow, NotificationRow, PairingCodeRow,
} from './types';
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add family-server/src/db.ts
git commit -m "feat(family-server): notification DB helpers"
```

---

### Task 4: Add notification HTTP handlers

**Files:**
- Create: `family-server/src/notifications.ts`

- [ ] **Step 1: Write the handlers**

`family-server/src/notifications.ts`:

```typescript
// Phase 3.1 — Family Inbox HTTP handlers.
//
// All three endpoints are parent-only (parent JWT, no device tokens).
//   GET  /api/v1/notifications        → { notifications: Notification[], unreadCount: number }
//   POST /api/v1/notifications/:id/read
//   POST /api/v1/notifications/read-all

import {
  countUnreadNotifications, listNotificationsForAccount,
  markAllNotificationsRead, markNotificationRead,
} from './db';
import type { Env, Notification, NotificationRow } from './types';
import { badRequest, json, notFound, requireAuth, unauthorized } from './utils';

function toApi(row: NotificationRow): Notification {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    payload: row.payload ? safeParse(row.payload) : null,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

export async function listNotificationsHandler(req: Request, env: Env): Promise<Response> {
  const ctx = await requireAuth(req, env);
  if (!ctx) return unauthorized();
  const rows = await listNotificationsForAccount(env.DB, ctx.accountId);
  const unreadCount = await countUnreadNotifications(env.DB, ctx.accountId);
  return json({ notifications: rows.map(toApi), unreadCount });
}

export async function markReadHandler(
  req: Request, env: Env, params: Record<string, string>,
): Promise<Response> {
  const ctx = await requireAuth(req, env);
  if (!ctx) return unauthorized();
  const id = Number(params.id);
  if (!Number.isFinite(id)) return badRequest('id must be a number');
  const ok = await markNotificationRead(env.DB, id, ctx.accountId);
  if (!ok) return notFound();
  return json({ ok: true });
}

export async function markAllReadHandler(req: Request, env: Env): Promise<Response> {
  const ctx = await requireAuth(req, env);
  if (!ctx) return unauthorized();
  const changed = await markAllNotificationsRead(env.DB, ctx.accountId);
  return json({ ok: true, marked: changed });
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add family-server/src/notifications.ts
git commit -m "feat(family-server): notification handlers"
```

---

### Task 5: Wire `pairRedeem` to create a device_paired notification

**Files:**
- Modify: `family-server/src/pairing.ts`

- [ ] **Step 1: Locate the success path**

Read `family-server/src/pairing.ts` and find where `pairRedeem` successfully inserts the new device row (it currently calls `logAudit` for `device_paired`). The notification write goes in the same place, immediately after the audit row.

- [ ] **Step 2: Add the notification write**

Add this import alongside the existing `./db` import:

```typescript
import { createNotification } from './db';
```

Inside `pairRedeem`, immediately after the existing `await logAudit(...)` for the `device_paired` event, add:

```typescript
const payload: import('./types').DevicePairedPayload = {
  deviceId:  device.id,
  hostname:  device.hostname,
  os:        device.os,
  osVersion: device.os_version,
  pairedAt:  device.paired_at,
};
await createNotification(
  env.DB, code.account_id, 'device_paired',
  hostname ? `${hostname} just paired` : 'A new device paired',
  hostname
    ? `${hostname} (${device.os}) is now linked to your family. You can block apps on it from the Family tab.`
    : `A new ${device.os} device is now linked to your family.`,
  payload,
).catch((err: unknown) => { console.warn('notification create failed', err); });
```

Use the local variable names that already exist in `pairRedeem`. If the device row is held in a different variable name (e.g. `row` or `dev`), substitute accordingly.

- [ ] **Step 3: Verify locally with curl**

In one terminal, from `family-server/`:

```bash
npm run dev
```

In another, run a signup → create pair code → redeem → list notifications cycle. Replace `BASE` with `http://localhost:8787`:

```bash
BASE=http://localhost:8787
# 1. Signup
TOKEN=$(curl -s -X POST $BASE/api/v1/auth/signup \
  -H 'content-type: application/json' \
  -d '{"email":"inbox-test@example.com","password":"testtest"}' | jq -r .token)

# 2. Create pair code
CODE=$(curl -s -X POST $BASE/api/v1/family/pair/create \
  -H "authorization: Bearer $TOKEN" | jq -r .code)

# 3. Redeem
curl -s -X POST $BASE/api/v1/family/pair/redeem \
  -H 'content-type: application/json' \
  -d "{\"code\":\"$CODE\",\"hostname\":\"test-mac\",\"os\":\"macos\",\"osVersion\":\"14.5\"}"
```

Then peek at the DB:

```bash
npx wrangler d1 execute focuslock-family --local \
  --command "SELECT id, kind, title FROM notifications;"
```

Expected: one row with `kind = 'device_paired'`, `title = 'test-mac just paired'`.

- [ ] **Step 4: Commit**

```bash
git add family-server/src/pairing.ts
git commit -m "feat(family-server): notify parent inbox on device pair"
```

---

### Task 6: Register inbox routes in `index.ts`

**Files:**
- Modify: `family-server/src/index.ts`

- [ ] **Step 1: Add imports + route registrations**

In `family-server/src/index.ts`, add to the imports block:

```typescript
import { listNotificationsHandler, markAllReadHandler, markReadHandler } from './notifications';
```

Add a new section just before `// ── CORS ──`:

```typescript
// ── Notifications (Phase 3.1 — Family Inbox) ───────────────────────────────
add('GET',  '/api/v1/notifications',              listNotificationsHandler);
add('POST', '/api/v1/notifications/:id/read',     markReadHandler);
add('POST', '/api/v1/notifications/read-all',     markAllReadHandler);
```

- [ ] **Step 2: Verify with curl**

With `npm run dev` running and the `TOKEN` from Task 5 in scope:

```bash
curl -s $BASE/api/v1/notifications -H "authorization: Bearer $TOKEN" | jq .
```

Expected: `{ "notifications": [ { "kind": "device_paired", "title": "test-mac just paired", "readAt": null, ... } ], "unreadCount": 1 }`.

Then mark it read:

```bash
ID=$(curl -s $BASE/api/v1/notifications -H "authorization: Bearer $TOKEN" | jq '.notifications[0].id')
curl -s -X POST $BASE/api/v1/notifications/$ID/read -H "authorization: Bearer $TOKEN" | jq .
curl -s $BASE/api/v1/notifications -H "authorization: Bearer $TOKEN" | jq '.unreadCount'
```

Expected: `{ "ok": true }`, then `0`.

- [ ] **Step 3: Commit**

```bash
git add family-server/src/index.ts
git commit -m "feat(family-server): expose notification routes"
```

---

### Task 7: Weekly digest aggregation

**Files:**
- Create: `family-server/src/digest.ts`

- [ ] **Step 1: Write the aggregator**

`family-server/src/digest.ts`:

```typescript
// Phase 3.1 — weekly digest aggregator. Reads the last 7 days of audit_log
// per account and writes one notification per account summarizing block
// activity. Idempotent within a run: callers (the scheduled handler) own
// scheduling, this just runs the SQL.

import { createNotification } from './db';
import type { Env, WeeklyDigestPayload } from './types';

const WINDOW_MS = 7 * 24 * 3600 * 1000;
const TOP_N = 5;

interface AuditRow {
  account_id: string;
  event: string;
  payload: string | null;
  device_id: string | null;
  created_at: string;
}

export async function runWeeklyDigests(env: Env, now: Date = new Date()): Promise<number> {
  const periodEnd = now;
  const periodStart = new Date(now.getTime() - WINDOW_MS);
  const startIso = periodStart.toISOString();
  const endIso = periodEnd.toISOString();

  // Pull rule_create events and online devices for every account in one shot.
  const auditRes = await env.DB.prepare(
    `SELECT account_id, event, payload, device_id, created_at
     FROM audit_log
     WHERE created_at >= ? AND created_at < ?
       AND account_id IS NOT NULL
       AND event IN ('rule_create','device_pair','device_unpair')`,
  ).bind(startIso, endIso).all();

  const audits = (auditRes.results ?? []) as unknown as AuditRow[];
  if (audits.length === 0) return 0;

  // Group by account.
  const byAccount = new Map<string, AuditRow[]>();
  for (const row of audits) {
    const list = byAccount.get(row.account_id) ?? [];
    list.push(row);
    byAccount.set(row.account_id, list);
  }

  // Devices "active" in the window: any device whose last_seen_at is in range.
  // One query, then group client-side.
  const devicesRes = await env.DB.prepare(
    `SELECT account_id, id FROM devices WHERE last_seen_at >= ?`,
  ).bind(startIso).all();
  const activeByAccount = new Map<string, Set<string>>();
  for (const row of (devicesRes.results ?? []) as Array<{ account_id: string; id: string }>) {
    const set = activeByAccount.get(row.account_id) ?? new Set();
    set.add(row.id);
    activeByAccount.set(row.account_id, set);
  }

  let written = 0;
  for (const [accountId, rows] of byAccount) {
    const ruleCreates = rows.filter(r => r.event === 'rule_create');
    if (ruleCreates.length === 0) continue;        // skip silent weeks

    const appCounts = new Map<string, number>();
    const domainCounts = new Map<string, number>();
    for (const r of ruleCreates) {
      const p = safeParse(r.payload);
      if (!p || typeof p !== 'object') continue;
      const apps = Array.isArray((p as { apps?: unknown }).apps)
        ? (p as { apps: unknown[] }).apps : [];
      const domains = Array.isArray((p as { domains?: unknown }).domains)
        ? (p as { domains: unknown[] }).domains : [];
      for (const a of apps) if (typeof a === 'string') appCounts.set(a, (appCounts.get(a) ?? 0) + 1);
      for (const d of domains) if (typeof d === 'string') domainCounts.set(d, (domainCounts.get(d) ?? 0) + 1);
    }

    const topApps = topN(appCounts, TOP_N);
    const topDomains = topN(domainCounts, TOP_N);
    const activeDeviceCount = activeByAccount.get(accountId)?.size ?? 0;

    const payload: WeeklyDigestPayload = {
      periodStartIso: startIso,
      periodEndIso: endIso,
      ruleCreates: ruleCreates.length,
      topApps,
      topDomains,
      activeDeviceCount,
    };

    const title = `This week: ${ruleCreates.length} block${ruleCreates.length === 1 ? '' : 's'}`;
    const bodyParts: string[] = [];
    bodyParts.push(`You created ${ruleCreates.length} block rule${ruleCreates.length === 1 ? '' : 's'} across ${activeDeviceCount} active device${activeDeviceCount === 1 ? '' : 's'}.`);
    if (topApps.length > 0) bodyParts.push(`Top apps: ${topApps.join(', ')}.`);
    if (topDomains.length > 0) bodyParts.push(`Top domains: ${topDomains.join(', ')}.`);

    await createNotification(
      env.DB, accountId, 'weekly_digest', title, bodyParts.join(' '), payload,
    );
    written++;
  }

  return written;
}

function topN(counts: Map<string, number>, n: number): string[] {
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
}

function safeParse(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add family-server/src/digest.ts
git commit -m "feat(family-server): weekly digest aggregator"
```

---

### Task 8: Schedule the digest cron and add the `scheduled` handler

**Files:**
- Modify: `family-server/wrangler.toml`
- Modify: `family-server/src/index.ts`

- [ ] **Step 1: Add the cron trigger to wrangler.toml**

Append to `family-server/wrangler.toml`:

```toml
# Phase 3.1 — Family Inbox weekly digest.
# Mondays at 14:00 UTC (mid-morning US Pacific, mid-afternoon UK, evening EU).
[triggers]
crons = ["0 14 * * 1"]
```

- [ ] **Step 2: Add the `scheduled` export to `index.ts`**

At the top of `family-server/src/index.ts`, add the import:

```typescript
import { runWeeklyDigests } from './digest';
```

Replace the `export default { async fetch ... }` block with a default that also handles `scheduled`:

```typescript
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const res = await dispatch(req, env);
    if (res.status === 101) return res;
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },

  // Cloudflare invokes this on the cron schedule defined in wrangler.toml.
  // We run synchronously inside ctx.waitUntil so the platform considers the
  // job done only once the digest writes have committed.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runWeeklyDigests(env).then(
      n => console.log(`weekly digest: wrote ${n} notifications`),
      err => console.error('weekly digest failed', err),
    ));
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 3: Manually trigger the scheduled handler locally**

`wrangler dev` exposes the scheduled handler at `http://localhost:8787/__scheduled`. With dev running and using the `TOKEN` from Task 5:

First, seed an audit row so the digest has something to summarize. Easiest: create one block rule on the device that paired in Task 5.

```bash
DID=$(curl -s $BASE/api/v1/family/devices -H "authorization: Bearer $TOKEN" | jq -r '.devices[0].id')
curl -s -X POST $BASE/api/v1/family/devices/$DID/rules \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"kind":"block_now","targetApps":["Discord"],"targetDomains":["reddit.com"]}'
```

Then fire the cron:

```bash
curl -s "http://localhost:8787/__scheduled?cron=0+14+*+*+1"
```

Verify a digest row exists:

```bash
curl -s $BASE/api/v1/notifications -H "authorization: Bearer $TOKEN" | jq '.notifications[] | select(.kind=="weekly_digest")'
```

Expected: a notification with `title` matching `"This week: 1 block"` and `payload.topApps` containing `"Discord"`.

- [ ] **Step 4: Commit**

```bash
git add family-server/wrangler.toml family-server/src/index.ts
git commit -m "feat(family-server): weekly digest cron + scheduled handler"
```

---

### Task 9: UI — `familyApi` client methods + types

**Files:**
- Modify: `ui/src/lib/familyApi.ts`

- [ ] **Step 1: Add the Notification type**

Open `ui/src/lib/familyApi.ts`. Locate the existing `export interface LockRule` block. Add immediately below it:

```typescript
export interface Notification {
  id: number;
  kind: 'weekly_digest' | 'device_paired';
  title: string;
  body: string;
  payload: unknown;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationListResponse {
  notifications: Notification[];
  unreadCount: number;
}
```

- [ ] **Step 2: Add the client methods**

Find the existing `export const family = { ... }` namespace. Below it (or inside it — match the file's existing pattern), add:

```typescript
export const notifications = {
  async list(token: string): Promise<NotificationListResponse> {
    return request<NotificationListResponse>('GET', '/api/v1/notifications', null, token);
  },
  async markRead(token: string, id: number): Promise<void> {
    await request<{ ok: true }>('POST', `/api/v1/notifications/${id}/read`, null, token);
  },
  async markAllRead(token: string): Promise<void> {
    await request<{ ok: true }>('POST', '/api/v1/notifications/read-all', null, token);
  },
};
```

If the file uses a different request-helper name (e.g. `apiFetch`, `req`), substitute accordingly — grep the file for the call signature used by `family.listDevices` and mirror it exactly.

- [ ] **Step 3: Type-check**

From `ui/`:

```bash
npx tsc --noEmit
```

Expected: no output, exit 0.

- [ ] **Step 4: Commit**

```bash
git add ui/src/lib/familyApi.ts
git commit -m "feat(ui): familyApi notification client"
```

---

### Task 10: UI — extend the family Zustand store

**Files:**
- Modify: `ui/src/stores/family.ts`

- [ ] **Step 1: Add state + actions**

Open `ui/src/stores/family.ts`.

Update the import line at the top to pull in `notifications` and the new types:

```typescript
import {
  account, auth, family, notifications as notificationsApi, FamilyApiError,
  type DeviceSummary, type LockRule, type Notification, type Session,
} from '../lib/familyApi';
```

Extend the `State` interface:

```typescript
interface State {
  session: Session | null;
  devices: DeviceSummary[];
  rulesByDevice: Record<string, LockRule[]>;
  loading: boolean;
  error: string | null;
  pairCode: { code: string; expiresAt: string } | null;
  notifications: Notification[];
  unreadCount: number;
}
```

Extend the `Actions` interface:

```typescript
  loadNotifications(): Promise<void>;
  markNotificationRead(id: number): Promise<void>;
  markAllNotificationsRead(): Promise<void>;
```

In the `create<Store>((set, get) => ({ ... }))` body, add `notifications: []` and `unreadCount: 0` to the initial state, and add the three actions. Insert them next to `loadDevices`:

```typescript
  async loadNotifications() {
    const s = get().session;
    if (!s) return;
    try {
      const { notifications, unreadCount } = await notificationsApi.list(s.token);
      set({ notifications, unreadCount });
    } catch (e) {
      if (e instanceof FamilyApiError && e.status === 401) { get().logout(); return; }
      // Silent for transient errors — inbox is non-critical UX.
      console.warn('loadNotifications failed', e);
    }
  },

  async markNotificationRead(id) {
    const s = get().session;
    if (!s) return;
    // Optimistic update: mark locally first, then sync.
    const now = new Date().toISOString();
    const next = get().notifications.map(n => n.id === id && n.readAt == null ? { ...n, readAt: now } : n);
    const unread = next.filter(n => n.readAt == null).length;
    set({ notifications: next, unreadCount: unread });
    try { await notificationsApi.markRead(s.token, id); }
    catch (e) { console.warn('markRead failed', e); /* eventual reload will reconcile */ }
  },

  async markAllNotificationsRead() {
    const s = get().session;
    if (!s) return;
    const now = new Date().toISOString();
    const next = get().notifications.map(n => n.readAt == null ? { ...n, readAt: now } : n);
    set({ notifications: next, unreadCount: 0 });
    try { await notificationsApi.markAllRead(s.token); }
    catch (e) { console.warn('markAllRead failed', e); }
  },
```

In `logout()`, add `notifications: [], unreadCount: 0,` to the cleared state object so a sign-out doesn't leak the previous parent's inbox.

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add ui/src/stores/family.ts
git commit -m "feat(ui): family store inbox state + actions"
```

---

### Task 11: UI — FamilyInbox component

**Files:**
- Create: `ui/src/components/FamilyInbox.tsx`

- [ ] **Step 1: Write the component**

`ui/src/components/FamilyInbox.tsx`:

```typescript
import { useEffect } from 'react';
import { useFamily } from '../stores/family';
import { Icon } from './Icons';
import { Pill } from './ui';
import { cn } from '../lib/cn';
import type { Notification } from '../lib/familyApi';

const POLL_INTERVAL_MS = 60_000;

export default function FamilyInbox(): JSX.Element | null {
  const notifications  = useFamily(s => s.notifications);
  const unreadCount    = useFamily(s => s.unreadCount);
  const loadNotifs     = useFamily(s => s.loadNotifications);
  const markRead       = useFamily(s => s.markNotificationRead);
  const markAllRead    = useFamily(s => s.markAllNotificationsRead);

  // Initial load + 60s poll while mounted. Same shape as the existing
  // devices poll in SignedInView — kept independent so a slow inbox call
  // never delays the device list.
  useEffect(() => {
    loadNotifs();
    const t = window.setInterval(loadNotifs, POLL_INTERVAL_MS);
    return () => window.clearInterval(t);
  }, [loadNotifs]);

  // Inbox is purely additive — if there's nothing yet, don't take up screen
  // space. The page already has plenty going on.
  if (notifications.length === 0) return null;

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <p className="text-[10px] uppercase tracking-[0.18em] text-dim font-semibold">Inbox</p>
          {unreadCount > 0 && <Pill tone="accent">{unreadCount} new</Pill>}
        </div>
        {unreadCount > 0 && (
          <button onClick={markAllRead}
            className="text-xs text-muted hover:text-text">
            Mark all read
          </button>
        )}
      </div>

      <ul className="space-y-2">
        {notifications.map(n => (
          <NotificationCard key={n.id} notification={n} onMarkRead={() => markRead(n.id)} />
        ))}
      </ul>
    </div>
  );
}

function NotificationCard({ notification, onMarkRead }: {
  notification: Notification;
  onMarkRead: () => void;
}): JSX.Element {
  const isUnread = notification.readAt == null;
  const iconForKind = notification.kind === 'weekly_digest' ? <Icon.Chart size={14} /> : <Icon.Users size={14} />;

  return (
    <li className={cn(
      'border rounded-md p-3 transition-colors',
      isUnread ? 'border-accent/30 bg-accent/5' : 'border-border/50',
    )}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-text flex items-center gap-2">
            <span className={cn(isUnread ? 'text-accent' : 'text-dim')}>{iconForKind}</span>
            {notification.title}
            {isUnread && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />}
          </p>
          <p className="text-xs text-muted mt-1 leading-relaxed">{notification.body}</p>
          <p className="text-[11px] text-faint mt-1.5 tnum">{relativeTime(notification.createdAt)}</p>
        </div>
        {isUnread && (
          <button onClick={onMarkRead}
            className="text-faint hover:text-text shrink-0"
            title="Mark read">
            <Icon.Check size={12} />
          </button>
        )}
      </div>
    </li>
  );
}

function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (ms < 0) return 'in the future';
  const s = Math.floor(ms / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no output, exit 0. If `Icon.Chart` or `Icon.Check` aren't exported, substitute existing icons used elsewhere in Family.tsx (`Icon.Sparkle`, `Icon.ShieldChk`, etc.).

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/FamilyInbox.tsx
git commit -m "feat(ui): FamilyInbox component"
```

---

### Task 12: UI — render FamilyInbox in `SignedInView`

**Files:**
- Modify: `ui/src/pages/Family.tsx`

- [ ] **Step 1: Import and render**

Add the import near the existing component imports in `ui/src/pages/Family.tsx`:

```typescript
import FamilyInbox from '../components/FamilyInbox';
```

In `function SignedInView()`, render `<FamilyInbox />` immediately after `<EnvironmentWarning />` and before the "Account row" `<div className="card p-4 flex items-center justify-between">`. Final layout reads: environment warning → inbox → account row → error → devices header → pair code → devices.

- [ ] **Step 2: Manual test**

Spin everything up:

```bash
# Terminal A — local worker
cd family-server && npm run dev

# Terminal B — Tauri dev UI, pointed at the local worker
cd ui && VITE_FAMILY_API_URL=http://localhost:8787 npm run tauri dev
```

In the app:
1. Sign in to the inbox-test account (`inbox-test@example.com` / `testtest`).
2. Open Family. Expect to see an "Inbox" card with the `device_paired` notification from Task 5 (still unread).
3. Click the check icon — card fades to non-accent border.
4. Hit "Mark all read" if more than one — unread badge disappears.

- [ ] **Step 3: Commit**

```bash
git add ui/src/pages/Family.tsx
git commit -m "feat(ui): render FamilyInbox in SignedInView"
```

---

### Task 13: UI — unread badge on the Family Nav link

**Files:**
- Modify: `ui/src/components/Nav.tsx`

- [ ] **Step 1: Pull unread count into Nav**

Add to the imports in `ui/src/components/Nav.tsx`:

```typescript
import { useFamily } from '../stores/family';
```

Inside `export default function Nav()`, just after the existing `useDaemon` calls:

```typescript
const familyUnread = useFamily(s => s.unreadCount);
```

- [ ] **Step 2: Render the pill**

Modify the `NavLink` render to optionally show a badge. Inside the existing `g.links.map((link) => ...)` callback, change the rendered children. Replace:

```typescript
<link.Icon size={15} className="shrink-0 transition-colors" />
{link.label}
```

with:

```typescript
<link.Icon size={15} className="shrink-0 transition-colors" />
<span className="flex-1">{link.label}</span>
{link.to === '/family' && familyUnread > 0 && (
  <span className="ml-auto bg-accent text-bg text-[10px] font-bold tnum
    rounded-full px-1.5 py-0.5 min-w-[18px] text-center leading-tight">
    {familyUnread > 9 ? '9+' : familyUnread}
  </span>
)}
```

- [ ] **Step 3: Manual test**

With the dev app running:
1. Sign out of the family account, then sign back in — the inbox should reload, and if there are unread notifications the Family nav link shows the pill.
2. Open Family, click "Mark all read" — the pill in the Nav disappears immediately (Zustand state is shared).

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/Nav.tsx
git commit -m "feat(ui): unread-count badge on Family Nav link"
```

---

### Task 14: Bump version, changelog, deploy worker, ship

**Files:**
- Modify: `ui/package.json`
- Modify: `ui/src-tauri/tauri.conf.json`
- Modify: `landing/changelog.html`
- Modify: `docs/family-controls-status.md`

- [ ] **Step 1: Bump UI version to 1.3.0**

In `ui/package.json`, change `"version": "1.2.1"` to `"version": "1.3.0"`.

In `ui/src-tauri/tauri.conf.json`, change `"version": "1.2.1"` to `"version": "1.3.0"`.

- [ ] **Step 2: Add changelog entry**

In `landing/changelog.html`, insert a new `<article>` block immediately after the `<!-- ───── 2026-06-05 (latest) ───── -->` comment (so 1.3.0 sits at the top). Use the existing 1.2.1 entry as a structural template; content:

```html
    <!-- ───── 2026-06-08 (latest) ───── -->
    <article class="entry" data-type="app">
      <div class="entry-meta">
        <div class="entry-date">June 8, 2026</div>
        <span class="badge app">App</span>
        <span class="version-tag">1.3.0</span>
      </div>
      <div class="entry-body">
        <h2>Family Inbox — weekly recaps and pair notices, inside the app</h2>
        <ul>
          <li><strong>New "Inbox" card at the top of the Family tab.</strong> Chronological feed of things you'd otherwise miss: weekly recap of which apps and sites got blocked, and a notice every time a new device pairs to your account. No emails, nothing in your inbox you didn't ask for.</li>
          <li><strong>Mark-read per card or in bulk.</strong> Unread items have an accent border and a dot; click the check to dismiss, or hit "Mark all read" in the header.</li>
          <li><strong>Unread badge on the Family nav link.</strong> A small accent pill next to "Family" tells you how many things are waiting without opening the tab.</li>
          <li><strong>Foundation for child approval requests.</strong> The same feed will surface "Sam wants 15 min on reddit.com" when that feature ships — no second UI surface needed.</li>
        </ul>
      </div>
    </article>
```

Also update the date on the previous `(latest)` comment to remove the `(latest)` marker since 1.3.0 now holds that slot.

- [ ] **Step 3: Update status doc**

In `docs/family-controls-status.md`, append a row to the "What's done" table:

```markdown
| Phase 3.1 — Family Inbox (weekly digest + device-paired notifications, in-app feed) | ✅ | `family-server/src/notifications.ts`, `digest.ts`, migration `0004_notifications.sql`; `ui/src/components/FamilyInbox.tsx`, `ui/src/stores/family.ts` | <fill in commit hash> |
```

And under "Known issues / TODOs", remove or strike the (still-valid) "parent WS to /parent/ws" bullet only if Task 11's polling is judged sufficient — leave it otherwise.

- [ ] **Step 4: Apply migration to prod and deploy worker**

```bash
cd family-server
npm run db:migrate:remote
npm run deploy
```

Expected: `wrangler deploy` prints a deployed URL matching `https://focuslock-family.oscarpetrikas.workers.dev` and a green checkmark.

- [ ] **Step 5: Build the UI**

```bash
cd ../ui
VITE_FAMILY_API_URL=https://focuslock-family.oscarpetrikas.workers.dev npm run tauri build
```

Expected: build completes (the updater-signing error at the very end is harmless if no `TAURI_SIGNING_PRIVATE_KEY` is set; the `.app` is still produced).

- [ ] **Step 6: Install locally**

```bash
osascript -e 'tell application "FocusLock" to quit'
sleep 2
rm -rf /Applications/FocusLock.app
cp -R /Users/oscarpetrikas/focus-lock/ui/src-tauri/target/release/bundle/macos/FocusLock.app /Applications/
xattr -d com.apple.quarantine /Applications/FocusLock.app 2>/dev/null
open -a /Applications/FocusLock.app
```

Expected: the app launches, Family tab loads, Inbox card shows above the device list with at least one card (the device_paired notification produced during testing, or any digest produced by Cloudflare's cron).

- [ ] **Step 7: Commit, push, tag**

```bash
git add ui/package.json ui/src-tauri/tauri.conf.json landing/changelog.html docs/family-controls-status.md
git commit -m "feat: 1.3.0 — Family Inbox"
git push origin main
git tag v1.3.0
git push origin v1.3.0
```

Watch the release CI run:

```bash
gh run list --repo Relevant47/focus-lock --workflow release.yml --limit 1
```

---

## Self-Review

**Spec coverage check:**
- "Weekly digest cards" → Tasks 7 + 8 (aggregator + scheduled handler) + Task 11 renders `weekly_digest` kind. ✓
- "Child approval requests" → explicitly deferred to a follow-on plan; foundation laid (kind discriminator). ✓
- "Tamper alerts" → explicitly deferred (would need a new child-to-server upload endpoint); existing local `useTamperAlerts` in Family.tsx is unchanged and still fires OS notifications. ✓
- "New device paired notices" → Task 5. ✓
- "Badge count on Family nav" → Task 13. ✓
- "OS notification for time-sensitive ones" → existing `useTamperAlerts` already covers tamper; nothing else here is time-sensitive enough to warrant adding OS notifications to digests. If you want them on `device_paired`, add a small `useEffect` in `FamilyInbox.tsx` that fires `new Notification(...)` for new unread `device_paired` rows seen for the first time — leaving as a future polish.

**Placeholder scan:** No `TODO`, `TBD`, "add appropriate", "similar to Task N", or "fill in details" inside task steps. Step 3 of Task 14 has a `<fill in commit hash>` placeholder — that's intentional because the hash is only known after the prior commits land; the agent writes it during execution.

**Type consistency:**
- `Notification`, `NotificationRow`, `WeeklyDigestPayload`, `DevicePairedPayload` are defined once in `family-server/src/types.ts` (Task 2) and the matching UI `Notification` is defined once in `ui/src/lib/familyApi.ts` (Task 9). They are intentionally separate (server vs. client surface).
- DB helpers (`createNotification`, `listNotificationsForAccount`, `countUnreadNotifications`, `markNotificationRead`, `markAllNotificationsRead`) defined in Task 3 are called by the same names in Tasks 4, 5, 7.
- Store actions (`loadNotifications`, `markNotificationRead`, `markAllNotificationsRead`) defined in Task 10 are called by the same names in Tasks 11, 13.
- `unreadCount` is the single name used in state, API response, and Nav badge.

No drift.
