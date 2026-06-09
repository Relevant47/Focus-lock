# Family Approval Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Child-initiated, parent-resolved unblock requests — kid hits a block, picks 5/15/30/60 min, parent approves/denies from the Inbox card we shipped in 3.1. Approval creates a time-limited rule that lifts the block for that one app or domain for the chosen window, then re-engages.

**Architecture:** New D1 table `approval_requests` + new `lock_rules` kind `unblock_specific` (with `expires_at`). Server gains 5 endpoints (kid creates / kid polls / parent hydrates / parent approves / parent denies) and a per-minute cron sweep that flips overdue requests to expired. Daemons (Win + Mac) mirror the new rule kind and respect `expires_at`. Parent UI gets a card variant with Approve/Deny + OS notification on arrival; child UI gets a "Ask for N min" button on each active rule in `ChildPairedView`.

**Tech Stack:** Cloudflare Worker + D1 + Durable Objects (TS), C# .NET 8 daemon (Windows), Swift 5.9 daemon (macOS), React 18 + Zustand + Tauri 2 (UI).

**Scope notes:**
- **Block-intercept page changes deferred to Phase 3.2b** (kid asks from the Family tab in this plan; the intercept-page button is the only thing we drop here).
- **No Account DO for parent WS push.** Parent UI continues to poll the Inbox every 60s (shipped in 3.1). The Worker pushes new requests only to the child WS (existing `DEVICE_CONN`); a "no parent WS yet" deferred per the spec's open question.

**Reference:** `/Users/oscarpetrikas/focus-lock/docs/superpowers/specs/2026-06-09-family-approval-requests-design.md` is the design spec.

---

## File structure

**New files:**
- `family-server/migrations/0005_approval_requests.sql`
- `family-server/migrations/0006_lock_rule_expires_at.sql`
- `family-server/src/approvalRequests.ts` (HTTP handlers + DB helpers, single responsibility)
- `ui/src/components/useNewRequestAlerts.ts` (small hook for OS notifications)

**Modified:**
- `family-server/src/types.ts` (new types; extend `LockRule.kind`)
- `family-server/src/db.ts` (extend `createRule` to accept `expiresAt` + filter expired in `listActiveRulesForDevice`)
- `family-server/src/index.ts` (register routes; extend `scheduled` to dispatch per-minute sweep)
- `family-server/src/devices.ts` (validate the new kind in `createRuleHandler`)
- `family-server/src/digest.ts` (no change for this plan; left untouched)
- `shared/protocol.ts` (extend `FamilyRuleSummary.kind`, add `expiresAt`, new IPC types)
- `daemon-win/FocusLock.Daemon/Models/*` (kind union + expiresAt mirror)
- `daemon-win/FocusLock.Daemon/Services/CronEvaluator.cs` (priority for `unblock_specific`)
- `daemon-win/FocusLock.Daemon/Services/FamilyService.cs` (IPC handler for `request_unblock` / `request_status`)
- `daemon-mac/Sources/FocusLockDaemon/Models.swift` (mirror)
- `daemon-mac/Sources/FocusLockDaemon/CronEvaluator.swift` (priority)
- `daemon-mac/Sources/FocusLockDaemon/FamilyService.swift` (IPC)
- `ui/src/lib/familyApi.ts` (extend Notification union + new `requests` namespace)
- `ui/src/stores/family.ts` (approve/deny actions; `requestUnblock` action)
- `ui/src/components/FamilyInbox.tsx` (card variant for `approval_request` kind)
- `ui/src/pages/Family.tsx` (mount `useNewRequestAlerts`; "Ask for N min" buttons in `ChildPairedView`)
- `ui/src-tauri/src/lib.rs` (Tauri command bridge for the new IPC types)
- `family-server/wrangler.toml` (add per-minute cron)
- `ui/package.json`, `ui/src-tauri/tauri.conf.json` (1.4.0 bump)
- `landing/changelog.html`, `docs/family-controls-status.md`

---

## Phase A — Server (Tasks 1–8)

### Task 1: `approval_requests` table migration

**Files:**
- Create: `family-server/migrations/0005_approval_requests.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Phase 3.2 — child-initiated approval requests. One row per ask.
-- status transitions: pending → approved | denied | expired.
-- resolution_rule_id is FK to the lock_rules row created on approval.

CREATE TABLE approval_requests (
  id                  TEXT PRIMARY KEY,
  account_id          TEXT NOT NULL,
  device_id           TEXT NOT NULL,
  target_kind         TEXT NOT NULL,             -- 'app' | 'domain'
  target              TEXT NOT NULL,             -- 'reddit.com' or 'Discord'
  requested_minutes   INTEGER NOT NULL,          -- 5 | 15 | 30 | 60
  status              TEXT NOT NULL,             -- 'pending' | 'approved' | 'denied' | 'expired'
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,             -- created_at + 1h
  resolved_at         TEXT,
  resolution_rule_id  TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (device_id)  REFERENCES devices(id)  ON DELETE CASCADE
);

CREATE INDEX idx_appr_account_status  ON approval_requests(account_id, status, created_at DESC);
CREATE INDEX idx_appr_pending_expiry  ON approval_requests(status, expires_at);
CREATE INDEX idx_appr_dedup           ON approval_requests(device_id, target_kind, target, status);
```

- [ ] **Step 2: Apply locally and verify**

```bash
cd /Users/oscarpetrikas/focus-lock/family-server
npm run db:migrate:local
npx wrangler d1 execute focuslock-family --local \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name='approval_requests';"
```

Expected: result includes `"name": "approval_requests"`.

- [ ] **Step 3: Commit**

```bash
git -C /Users/oscarpetrikas/focus-lock add family-server/migrations/0005_approval_requests.sql
git -C /Users/oscarpetrikas/focus-lock commit -m "feat(family-server): approval_requests table"
```

---

### Task 2: `lock_rules.expires_at` column migration

**Files:**
- Create: `family-server/migrations/0006_lock_rule_expires_at.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Phase 3.2 — time-limited rules (unblock_specific kind) need a per-row
-- expiry timestamp. NULL for everything else (legacy + block_now + schedule
-- + unblock_all all stay permanent until manually removed).

ALTER TABLE lock_rules ADD COLUMN expires_at TEXT;
```

- [ ] **Step 2: Apply locally and verify**

```bash
cd /Users/oscarpetrikas/focus-lock/family-server
npm run db:migrate:local
npx wrangler d1 execute focuslock-family --local \
  --command "PRAGMA table_info(lock_rules);"
```

Expected: result lists an `expires_at` column with type `TEXT`, not null `0`.

- [ ] **Step 3: Commit**

```bash
git -C /Users/oscarpetrikas/focus-lock add family-server/migrations/0006_lock_rule_expires_at.sql
git -C /Users/oscarpetrikas/focus-lock commit -m "feat(family-server): lock_rules.expires_at column"
```

---

### Task 3: Server types

**Files:**
- Modify: `family-server/src/types.ts`

- [ ] **Step 1: Extend `LockRuleRow` and `LockRule` to include the new kind + `expires_at`**

Find the existing `LockRuleRow` and `LockRule` interfaces. Update the `kind` union and add `expires_at` / `expiresAt`:

```typescript
export interface LockRuleRow {
  id: string;
  device_id: string;
  kind: 'block_now' | 'schedule' | 'unblock_all' | 'unblock_specific';
  target_apps: string | null;
  target_domains: string | null;
  schedule_cron: string | null;
  active: number;
  created_at: string;
  created_by_account_id: string;
  expires_at: string | null;
}

export interface LockRule {
  id: string;
  deviceId: string;
  kind: 'block_now' | 'schedule' | 'unblock_all' | 'unblock_specific';
  targetApps: string[];
  targetDomains: string[];
  scheduleCron: string | null;
  active: boolean;
  createdAt: string;
  expiresAt: string | null;
}
```

Update `CreateRuleRequest` to allow the new kind and accept optional `expiresAt`:

```typescript
export interface CreateRuleRequest {
  kind: 'block_now' | 'schedule' | 'unblock_all' | 'unblock_specific';
  targetApps?: string[];
  targetDomains?: string[];
  scheduleCron?: string;
  expiresAt?: string;   // ISO timestamp; only valid for kind=unblock_specific
}
```

- [ ] **Step 2: Add approval-request types** at the bottom of the file:

```typescript
export interface ApprovalRequestRow {
  id: string;
  account_id: string;
  device_id: string;
  target_kind: 'app' | 'domain';
  target: string;
  requested_minutes: number;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
  resolution_rule_id: string | null;
}

export interface ApprovalRequest {
  id: string;
  deviceId: string;
  targetKind: 'app' | 'domain';
  target: string;
  requestedMinutes: number;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  resolutionRuleId: string | null;
}

export interface CreateApprovalRequestBody {
  targetKind: 'app' | 'domain';
  target: string;
  requestedMinutes: 5 | 15 | 30 | 60;
}
```

- [ ] **Step 3: Extend the notifications kind** (in `NotificationRow` and `Notification` interfaces) — change the existing union from `'weekly_digest' | 'device_paired'` to `'weekly_digest' | 'device_paired' | 'approval_request'` in BOTH interfaces.

- [ ] **Step 4: Type-check**

```bash
cd /Users/oscarpetrikas/focus-lock/family-server && npx tsc --noEmit
```

Expected: only the two pre-existing errors (`src/devices.ts(6,53)` unused `LockRule`, `src/do.ts(15,11)` unused `state`). No new errors.

- [ ] **Step 5: Commit**

```bash
git -C /Users/oscarpetrikas/focus-lock add family-server/src/types.ts
git -C /Users/oscarpetrikas/focus-lock commit -m "feat(family-server): approval-request types + unblock_specific kind"
```

---

### Task 4: Server DB helpers

**Files:**
- Modify: `family-server/src/db.ts`

- [ ] **Step 1: Add `NotificationRow → ApprovalRequestRow` to the imports** at top of `db.ts`:

```typescript
import type {
  AccountRow, ApprovalRequestRow, AuditLogRow, DeviceRow, LockRule, LockRuleRow,
  NotificationRow, PairingCodeRow,
} from './types';
```

- [ ] **Step 2: Update the existing `createRule` helper** to accept the new kind + `expires_at`. Find the existing `export async function createRule(...)` and rewrite it to:

```typescript
export async function createRule(
  db: D1Database,
  deviceId: string,
  accountId: string,
  kind: 'block_now' | 'schedule' | 'unblock_all' | 'unblock_specific',
  apps: string[] | undefined,
  domains: string[] | undefined,
  scheduleCron: string | null,
  expiresAt: string | null = null,
): Promise<LockRule> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO lock_rules (id, device_id, kind, target_apps, target_domains, schedule_cron, active, created_at, created_by_account_id, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).bind(
    id, deviceId, kind,
    apps ? JSON.stringify(apps) : null,
    domains ? JSON.stringify(domains) : null,
    scheduleCron,
    now, accountId, expiresAt,
  ).run();
  return {
    id, deviceId, kind,
    targetApps: apps ?? [],
    targetDomains: domains ?? [],
    scheduleCron, active: true,
    createdAt: now,
    expiresAt,
  };
}
```

- [ ] **Step 3: Update `listActiveRulesForDevice`** to filter out expired rules. Find the existing helper and modify the SQL:

```typescript
export async function listActiveRulesForDevice(db: D1Database, deviceId: string): Promise<LockRule[]> {
  const now = new Date().toISOString();
  const { results } = await db.prepare(
    `SELECT * FROM lock_rules
     WHERE device_id = ? AND active = 1
       AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY created_at DESC`,
  ).bind(deviceId, now).all();
  const rows = (results ?? []) as unknown as LockRuleRow[];
  return rows.map(rowToLockRule);
}
```

(If your existing `rowToLockRule` helper doesn't yet map `expires_at`, update it to include `expiresAt: row.expires_at` in the returned object.)

- [ ] **Step 4: Append approval-request helpers** at the end of `db.ts`:

```typescript
// ── approval_requests (Family Approval) ────────────────────────────────────

const APPR_REQUEST_TTL_MS = 60 * 60 * 1000;   // 1 hour pending window

export async function createApprovalRequest(
  db: D1Database,
  accountId: string,
  deviceId: string,
  targetKind: 'app' | 'domain',
  target: string,
  requestedMinutes: number,
): Promise<ApprovalRequestRow> {
  const id = crypto.randomUUID();
  const now = new Date();
  const created_at = now.toISOString();
  const expires_at = new Date(now.getTime() + APPR_REQUEST_TTL_MS).toISOString();
  await db.prepare(
    `INSERT INTO approval_requests
       (id, account_id, device_id, target_kind, target, requested_minutes, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).bind(id, accountId, deviceId, targetKind, target, requestedMinutes, created_at, expires_at).run();
  return {
    id, account_id: accountId, device_id: deviceId,
    target_kind: targetKind, target, requested_minutes: requestedMinutes,
    status: 'pending', created_at, expires_at,
    resolved_at: null, resolution_rule_id: null,
  };
}

export async function findApprovalRequestById(
  db: D1Database, id: string,
): Promise<ApprovalRequestRow | null> {
  const row = await db.prepare('SELECT * FROM approval_requests WHERE id = ?').bind(id).first();
  return row as ApprovalRequestRow | null;
}

/// Returns an existing pending row for the same target on the same device.
/// Used for dedup: a retry just picks up the existing request rather than
/// spawning duplicates the parent then has to triage.
export async function findPendingApprovalForTarget(
  db: D1Database, deviceId: string, targetKind: 'app' | 'domain', target: string,
): Promise<ApprovalRequestRow | null> {
  const row = await db.prepare(
    `SELECT * FROM approval_requests
     WHERE device_id = ? AND target_kind = ? AND target = ? AND status = 'pending'
     LIMIT 1`,
  ).bind(deviceId, targetKind, target).first();
  return row as ApprovalRequestRow | null;
}

/// Atomic state transition: pending → approved. Returns true if the row
/// transitioned, false if it had already resolved or expired (the caller
/// then returns 409 to the parent UI).
export async function markApprovalResolved(
  db: D1Database, id: string, accountId: string,
  status: 'approved' | 'denied',
  resolutionRuleId: string | null,
): Promise<boolean> {
  const now = new Date().toISOString();
  const res = await db.prepare(
    `UPDATE approval_requests SET status = ?, resolved_at = ?, resolution_rule_id = ?
     WHERE id = ? AND account_id = ? AND status = 'pending' AND expires_at > ?`,
  ).bind(status, now, resolutionRuleId, id, accountId, now).run();
  return (res.meta?.changes ?? 0) > 0;
}

/// Cron sweep. Flips every overdue pending row to 'expired' in one shot.
/// Returns the rows that flipped so the caller can WS-notify their devices.
export async function expireOverduePending(db: D1Database): Promise<ApprovalRequestRow[]> {
  const now = new Date().toISOString();
  const sel = await db.prepare(
    `SELECT * FROM approval_requests WHERE status = 'pending' AND expires_at <= ?`,
  ).bind(now).all();
  const rows = (sel.results ?? []) as unknown as ApprovalRequestRow[];
  if (rows.length === 0) return [];
  await db.prepare(
    `UPDATE approval_requests SET status = 'expired', resolved_at = ?
     WHERE status = 'pending' AND expires_at <= ?`,
  ).bind(now, now).run();
  return rows;
}
```

- [ ] **Step 5: Type-check**

```bash
cd /Users/oscarpetrikas/focus-lock/family-server && npx tsc --noEmit
```

Expected: only the two known pre-existing errors.

- [ ] **Step 6: Commit**

```bash
git -C /Users/oscarpetrikas/focus-lock add family-server/src/db.ts
git -C /Users/oscarpetrikas/focus-lock commit -m "feat(family-server): approval-request DB helpers + expiresAt on rules"
```

---

### Task 5: Approval-request HTTP handlers

**Files:**
- Create: `family-server/src/approvalRequests.ts`

- [ ] **Step 1: Write the file**

```typescript
// Phase 3.2 — child-initiated approval requests. Five endpoints split by auth:
//
// Device-authed (kid daemon):
//   POST /api/v1/family/requests              → create + dedup
//   GET  /api/v1/device/requests/:id          → poll status
//
// Parent-authed:
//   GET  /api/v1/family/requests/:id          → hydrate one row
//   POST /api/v1/family/requests/:id/approve  → atomic flip + create rule
//   POST /api/v1/family/requests/:id/deny     → atomic flip

import {
  createApprovalRequest, createNotification, createRule, findApprovalRequestById,
  findPendingApprovalForTarget, markApprovalResolved,
} from './db';
import type {
  ApprovalRequest, ApprovalRequestRow, CreateApprovalRequestBody, Env,
} from './types';
import {
  badRequest, clientIp, conflict, json, notFound,
  requireAuth, requireDeviceAuth, safeJson, unauthorized,
} from './utils';

const ALLOWED_MINUTES = new Set([5, 15, 30, 60]);

function toApi(row: ApprovalRequestRow): ApprovalRequest {
  return {
    id: row.id,
    deviceId: row.device_id,
    targetKind: row.target_kind,
    target: row.target,
    requestedMinutes: row.requested_minutes,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    resolutionRuleId: row.resolution_rule_id,
  };
}

// ── Kid creates a request ──────────────────────────────────────────────────

export async function createRequestHandler(req: Request, env: Env): Promise<Response> {
  const ctx = await requireDeviceAuth(req, env);
  if (!ctx) return unauthorized();

  const body = await safeJson<CreateApprovalRequestBody>(req);
  if (!body || (body.targetKind !== 'app' && body.targetKind !== 'domain')) {
    return badRequest('targetKind must be "app" or "domain"');
  }
  if (typeof body.target !== 'string' || body.target.trim() === '') {
    return badRequest('target required');
  }
  if (!ALLOWED_MINUTES.has(Number(body.requestedMinutes))) {
    return badRequest('requestedMinutes must be 5, 15, 30, or 60');
  }
  const target = body.target.trim();

  // Dedup: if there's already a pending row for the same target, return it.
  const existing = await findPendingApprovalForTarget(env.DB, ctx.deviceId, body.targetKind, target);
  if (existing) return json({ request: toApi(existing) });

  const row = await createApprovalRequest(
    env.DB, ctx.accountId, ctx.deviceId, body.targetKind, target, Number(body.requestedMinutes),
  );

  // Hydrate the device's hostname so the notification title is human-readable.
  const dev = await env.DB.prepare('SELECT hostname FROM devices WHERE id = ?')
    .bind(ctx.deviceId).first<{ hostname: string | null }>();
  const host = dev?.hostname ?? 'A device';

  await createNotification(
    env.DB, ctx.accountId, 'approval_request',
    `${host} wants ${target} for ${row.requested_minutes}m`,
    `Approve or deny in the Family Inbox. Asks expire after an hour.`,
    { requestId: row.id },
  ).catch((err: unknown) => { console.warn('approval notification failed', err); });

  return json({ request: toApi(row) });
}

// ── Kid polls status ───────────────────────────────────────────────────────

export async function deviceGetRequestHandler(
  req: Request, env: Env, params: Record<string, string>,
): Promise<Response> {
  const ctx = await requireDeviceAuth(req, env);
  if (!ctx) return unauthorized();
  const row = await findApprovalRequestById(env.DB, params.id);
  if (!row || row.device_id !== ctx.deviceId) return notFound();
  return json({ request: toApi(row) });
}

// ── Parent hydrates one row ────────────────────────────────────────────────

export async function parentGetRequestHandler(
  req: Request, env: Env, params: Record<string, string>,
): Promise<Response> {
  const ctx = await requireAuth(req, env);
  if (!ctx) return unauthorized();
  const row = await findApprovalRequestById(env.DB, params.id);
  if (!row || row.account_id !== ctx.accountId) return notFound();
  return json({ request: toApi(row) });
}

// ── Parent approves ────────────────────────────────────────────────────────

export async function approveRequestHandler(
  req: Request, env: Env, params: Record<string, string>,
): Promise<Response> {
  const ctx = await requireAuth(req, env);
  if (!ctx) return unauthorized();

  const row = await findApprovalRequestById(env.DB, params.id);
  if (!row || row.account_id !== ctx.accountId) return notFound();
  if (row.status !== 'pending') return conflict(`already ${row.status}`);
  if (Date.parse(row.expires_at) <= Date.now()) return conflict('expired');

  // Create the time-limited rule first so we can stamp its id on the request.
  const expires = new Date(Date.now() + row.requested_minutes * 60 * 1000).toISOString();
  const rule = await createRule(
    env.DB, row.device_id, ctx.accountId, 'unblock_specific',
    row.target_kind === 'app' ? [row.target] : undefined,
    row.target_kind === 'domain' ? [row.target] : undefined,
    null, expires,
  );

  const ok = await markApprovalResolved(env.DB, row.id, ctx.accountId, 'approved', rule.id);
  if (!ok) {
    // Lost the race — another approve / expiry beat us. Roll back the rule.
    await env.DB.prepare('DELETE FROM lock_rules WHERE id = ?').bind(rule.id).run();
    return conflict('already resolved');
  }

  // Push the new rule to the device so it lifts the block within seconds.
  await notifyDevice(env, row.device_id, { type: 'rule_change', rule }).catch(() => { /* offline */ });

  return json({ request: toApi({ ...row, status: 'approved', resolved_at: new Date().toISOString(), resolution_rule_id: rule.id }), rule });
}

// ── Parent denies ──────────────────────────────────────────────────────────

export async function denyRequestHandler(
  req: Request, env: Env, params: Record<string, string>,
): Promise<Response> {
  const ctx = await requireAuth(req, env);
  if (!ctx) return unauthorized();

  const row = await findApprovalRequestById(env.DB, params.id);
  if (!row || row.account_id !== ctx.accountId) return notFound();
  if (row.status !== 'pending') return conflict(`already ${row.status}`);

  const ok = await markApprovalResolved(env.DB, row.id, ctx.accountId, 'denied', null);
  if (!ok) return conflict('already resolved');

  await notifyDevice(env, row.device_id, { type: 'request_resolved', requestId: row.id, status: 'denied' })
    .catch(() => { /* offline */ });

  return json({ request: toApi({ ...row, status: 'denied', resolved_at: new Date().toISOString() }) });
}

// ── Local helper: device WS push (mirror of devices.ts pattern) ────────────

async function notifyDevice(env: Env, deviceId: string, message: object): Promise<void> {
  const id = env.DEVICE_CONN.idFromName(deviceId);
  const stub = env.DEVICE_CONN.get(id);
  await stub.fetch('http://device-conn/notify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
  });
}

// Re-mark `clientIp` as used (lint) — handlers above all accept the request
// for future audit additions even though we don't log here yet.
void clientIp;
```

- [ ] **Step 2: Type-check**

```bash
cd /Users/oscarpetrikas/focus-lock/family-server && npx tsc --noEmit
```

Expected: only the two pre-existing errors.

- [ ] **Step 3: Commit**

```bash
git -C /Users/oscarpetrikas/focus-lock add family-server/src/approvalRequests.ts
git -C /Users/oscarpetrikas/focus-lock commit -m "feat(family-server): approval-request HTTP handlers"
```

---

### Task 6: Register routes + extend `createRuleHandler` validation

**Files:**
- Modify: `family-server/src/index.ts`
- Modify: `family-server/src/devices.ts`

- [ ] **Step 1: Update `createRuleHandler` in `devices.ts`** to accept the new kind. Find the validation block that currently rejects anything other than `block_now | schedule | unblock_all` and add `unblock_specific`. Also accept the optional `expiresAt`:

```typescript
if (body.kind !== 'block_now' && body.kind !== 'schedule'
    && body.kind !== 'unblock_all' && body.kind !== 'unblock_specific') {
  return badRequest('kind must be block_now | schedule | unblock_all | unblock_specific');
}
if (body.kind === 'schedule' && typeof body.scheduleCron !== 'string') {
  return badRequest('scheduleCron required for kind=schedule');
}
if (body.kind === 'unblock_specific' && (typeof body.expiresAt !== 'string')) {
  return badRequest('expiresAt required for kind=unblock_specific');
}
```

Pass `expiresAt` through to the existing `createRule(...)` call (the helper now accepts it as the last arg, defaulting to `null`):

```typescript
const rule = await createRule(
  env.DB, params.id, ctx.accountId, body.kind,
  apps, domains,
  body.kind === 'schedule' ? body.scheduleCron! : null,
  body.kind === 'unblock_specific' ? body.expiresAt! : null,
);
```

- [ ] **Step 2: Add the imports + routes in `index.ts`.** Near the other handler imports:

```typescript
import {
  approveRequestHandler, createRequestHandler, denyRequestHandler,
  deviceGetRequestHandler, parentGetRequestHandler,
} from './approvalRequests';
```

Then add a new section just before `// ── CORS ──`:

```typescript
// ── Approval Requests (Phase 3.2) ──────────────────────────────────────────
add('POST', '/api/v1/family/requests',                createRequestHandler);
add('GET',  '/api/v1/family/requests/:id',            parentGetRequestHandler);
add('POST', '/api/v1/family/requests/:id/approve',    approveRequestHandler);
add('POST', '/api/v1/family/requests/:id/deny',       denyRequestHandler);
add('GET',  '/api/v1/device/requests/:id',            deviceGetRequestHandler);
```

- [ ] **Step 3: Type-check**

```bash
cd /Users/oscarpetrikas/focus-lock/family-server && npx tsc --noEmit
```

Expected: only the two pre-existing errors.

- [ ] **Step 4: Commit**

```bash
git -C /Users/oscarpetrikas/focus-lock add family-server/src/index.ts family-server/src/devices.ts
git -C /Users/oscarpetrikas/focus-lock commit -m "feat(family-server): approval-request routes + unblock_specific validation"
```

---

### Task 7: Per-minute cron expiry sweep

**Files:**
- Modify: `family-server/wrangler.toml`
- Modify: `family-server/src/index.ts`

- [ ] **Step 1: Add the per-minute cron**

In `family-server/wrangler.toml`, find the existing `[triggers]` block and add the per-minute schedule next to the weekly digest:

```toml
[triggers]
crons = ["0 14 * * 1", "* * * * *"]
```

- [ ] **Step 2: Dispatch by cron in the `scheduled` handler.** Open `family-server/src/index.ts` and update the existing `scheduled` method to inspect `controller.cron`:

```typescript
import { expireOverduePending } from './db';

// ... existing imports ...

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (controller.cron === '0 14 * * 1') {
      ctx.waitUntil(runWeeklyDigests(env).then(
        n => console.log(`weekly digest: wrote ${n} notifications`),
        err => console.error('weekly digest failed', err),
      ));
    } else if (controller.cron === '* * * * *') {
      ctx.waitUntil(sweepExpiredRequests(env).then(
        n => { if (n > 0) console.log(`approval sweep: expired ${n} requests`); },
        err => console.error('approval sweep failed', err),
      ));
    }
  },
```

Add a small helper near the top of `index.ts`:

```typescript
async function sweepExpiredRequests(env: Env): Promise<number> {
  const expired = await expireOverduePending(env.DB);
  for (const row of expired) {
    // Best-effort: push request_resolved to the device so a polling block
    // page learns "expired" without spinning forever.
    const id = env.DEVICE_CONN.idFromName(row.device_id);
    const stub = env.DEVICE_CONN.get(id);
    stub.fetch('http://device-conn/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'request_resolved', requestId: row.id, status: 'expired' }),
    }).catch(() => { /* offline */ });
  }
  return expired.length;
}
```

- [ ] **Step 3: Verify locally end-to-end.** Start `wrangler dev`, drive a signup → pair → create request → wait → trigger `__scheduled?cron=*+*+*+*+*` and check the row flipped to `expired`.

```bash
cd /Users/oscarpetrikas/focus-lock/family-server

if [ ! -f .dev.vars ]; then
  echo "JWT_SECRET=$(openssl rand -hex 32)" > .dev.vars
  CLEANUP=1
fi

npm run dev > /tmp/wrangler-t7.log 2>&1 &
WPID=$!
sleep 5

BASE=http://localhost:8787
EMAIL="t7-$(date +%s)@example.com"
TOKEN=$(curl -s -X POST $BASE/api/v1/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"testtest\"}" | jq -r .token)
CODE=$(curl -s -X POST $BASE/api/v1/family/pair/create -H "authorization: Bearer $TOKEN" | jq -r .code)
DEV_TOKEN=$(curl -s -X POST $BASE/api/v1/family/pair/redeem -H 'content-type: application/json' \
  -d "{\"code\":\"$CODE\",\"hostname\":\"t7\",\"os\":\"macos\"}" | jq -r .deviceToken)

# Create a request
REQ=$(curl -s -X POST $BASE/api/v1/family/requests \
  -H "authorization: Bearer $DEV_TOKEN" -H 'content-type: application/json' \
  -d '{"targetKind":"domain","target":"reddit.com","requestedMinutes":15}')
RID=$(echo $REQ | jq -r .request.id)
echo "request: $RID"

# Manually force the row's expires_at into the past so the sweep grabs it
npx wrangler d1 execute focuslock-family --local --command \
  "UPDATE approval_requests SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = '$RID';"

# Fire the per-minute cron
curl -s "$BASE/__scheduled?cron=*+*+*+*+*" -o /dev/null -w "%{http_code}\n"

sleep 2
npx wrangler d1 execute focuslock-family --local --command \
  "SELECT id, status, resolved_at FROM approval_requests WHERE id='$RID';"

kill $WPID 2>/dev/null
wait $WPID 2>/dev/null
if [ "$CLEANUP" = "1" ]; then rm .dev.vars; fi
```

Expected: the final SELECT shows `status='expired'` and `resolved_at` set.

- [ ] **Step 4: Commit**

```bash
git -C /Users/oscarpetrikas/focus-lock add family-server/wrangler.toml family-server/src/index.ts
git -C /Users/oscarpetrikas/focus-lock commit -m "feat(family-server): per-minute cron sweeps expired approval requests"
```

---

### Task 8: End-to-end server verification

**Files:** none changed; this is a verification gate.

- [ ] **Step 1: Drive a full happy-path through the new endpoints.**

```bash
cd /Users/oscarpetrikas/focus-lock/family-server

if [ ! -f .dev.vars ]; then
  echo "JWT_SECRET=$(openssl rand -hex 32)" > .dev.vars
  CLEANUP=1
fi
npm run dev > /tmp/wrangler-t8.log 2>&1 &
WPID=$!
sleep 5

BASE=http://localhost:8787
EMAIL="t8-$(date +%s)@example.com"
TOKEN=$(curl -s -X POST $BASE/api/v1/auth/signup -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"testtest\"}" | jq -r .token)
CODE=$(curl -s -X POST $BASE/api/v1/family/pair/create -H "authorization: Bearer $TOKEN" | jq -r .code)
DEV_TOKEN=$(curl -s -X POST $BASE/api/v1/family/pair/redeem -H 'content-type: application/json' \
  -d "{\"code\":\"$CODE\",\"hostname\":\"t8\",\"os\":\"macos\"}" | jq -r .deviceToken)
DID=$(curl -s $BASE/api/v1/family/devices -H "authorization: Bearer $TOKEN" | jq -r '.devices[0].id')

# Parent puts a block on reddit.com first
curl -s -X POST $BASE/api/v1/family/devices/$DID/rules \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"kind":"block_now","targetApps":[],"targetDomains":["reddit.com"]}' > /dev/null

# Kid asks
echo "=== ask ==="
REQ=$(curl -s -X POST $BASE/api/v1/family/requests \
  -H "authorization: Bearer $DEV_TOKEN" -H 'content-type: application/json' \
  -d '{"targetKind":"domain","target":"reddit.com","requestedMinutes":15}')
echo $REQ | jq .
RID=$(echo $REQ | jq -r .request.id)

# Same ask returns the same id (dedup)
echo "=== ask again (dedup) ==="
REQ2=$(curl -s -X POST $BASE/api/v1/family/requests \
  -H "authorization: Bearer $DEV_TOKEN" -H 'content-type: application/json' \
  -d '{"targetKind":"domain","target":"reddit.com","requestedMinutes":30}')
echo $REQ2 | jq '.request.id == "'"$RID"'"'

# Kid polls status — pending
echo "=== kid poll (pending) ==="
curl -s $BASE/api/v1/device/requests/$RID -H "authorization: Bearer $DEV_TOKEN" | jq '.request.status'

# Notification surfaced to parent inbox
echo "=== parent inbox ==="
curl -s $BASE/api/v1/notifications -H "authorization: Bearer $TOKEN" \
  | jq '.notifications[] | select(.kind == "approval_request") | {kind, title}'

# Parent approves
echo "=== approve ==="
curl -s -X POST $BASE/api/v1/family/requests/$RID/approve \
  -H "authorization: Bearer $TOKEN" | jq '{status: .request.status, ruleKind: .rule.kind, ruleExpiresAt: .rule.expiresAt}'

# Active rules now include unblock_specific
echo "=== device active rules ==="
curl -s $BASE/api/v1/device/rules -H "authorization: Bearer $DEV_TOKEN" \
  | jq '.rules[] | {kind, expiresAt, apps: .targetApps, domains: .targetDomains}'

# Kid polls — approved
echo "=== kid poll (approved) ==="
curl -s $BASE/api/v1/device/requests/$RID -H "authorization: Bearer $DEV_TOKEN" \
  | jq '{status: .request.status, ruleId: .request.resolutionRuleId}'

# Re-approving a now-approved request → 409
echo "=== re-approve (409) ==="
curl -s -o /dev/null -w "%{http_code}\n" -X POST $BASE/api/v1/family/requests/$RID/approve \
  -H "authorization: Bearer $TOKEN"

kill $WPID 2>/dev/null
wait $WPID 2>/dev/null
if [ "$CLEANUP" = "1" ]; then rm .dev.vars; fi
```

Expected sequence:
1. **ask** → returns a request object with `status: "pending"`.
2. **ask again** → returns `true` (same id).
3. **kid poll (pending)** → `"pending"`.
4. **parent inbox** → at least one `kind: "approval_request"`, title `"t8 wants reddit.com for 15m"`.
5. **approve** → `{status: "approved", ruleKind: "unblock_specific", ruleExpiresAt: <iso>}`.
6. **device active rules** → at least one `unblock_specific` with `domains: ["reddit.com"]`, `expiresAt` non-null.
7. **kid poll (approved)** → `{status: "approved", ruleId: <non-null>}`.
8. **re-approve** → `409`.

- [ ] **Step 2: Commit a no-op verification marker so the branch has an explicit "server side done" anchor.**

```bash
git -C /Users/oscarpetrikas/focus-lock commit --allow-empty \
  -m "test(family-server): approval-request server flow verified end-to-end"
```

---

## Phase B — Shared protocol + daemon mirrors (Tasks 9–14)

### Task 9: `shared/protocol.ts` updates

**Files:**
- Modify: `shared/protocol.ts`

- [ ] **Step 1: Extend `FamilyRuleSummary`** to include the new kind and `expiresAt`:

Find the existing `FamilyRuleSummary` interface and update:

```typescript
export interface FamilyRuleSummary {
  id: string;
  kind: "block_now" | "schedule" | "unblock_all" | "unblock_specific";
  targetApps: string[];
  targetDomains: string[];
  scheduleCron: string | null;
  createdAt: string;
  expiresAt: string | null;
}
```

- [ ] **Step 2: Extend `FamilyDataExport.lock_rules[].kind`** similarly to include `"unblock_specific"` and add `expires_at: string | null`.

- [ ] **Step 3: Add new IPC message types** at the end of the file in a new section:

```typescript
// ── Family approval requests (Phase 3.2) ─────────────────────────────────────

export interface RequestUnblockPayload {
  target: string;
  targetKind: "app" | "domain";
  minutes: 5 | 15 | 30 | 60;
}

export interface RequestUnblockResult {
  requestId: string;
  expiresAt: string;
}

export interface RequestStatusPayload {
  requestId: string;
}

export interface RequestStatusResult {
  status: "pending" | "approved" | "denied" | "expired";
  resolutionRuleExpiresAt: string | null;
}
```

- [ ] **Step 4: Type-check from `ui/`** (which imports `@shared/protocol`):

```bash
cd /Users/oscarpetrikas/focus-lock/ui && npx tsc --noEmit
```

Expected: any errors only from spots that referenced the old `kind` union literally — we'll fix those as we touch them in later UI tasks. No errors that aren't from this rename.

- [ ] **Step 5: Commit**

```bash
git -C /Users/oscarpetrikas/focus-lock add shared/protocol.ts
git -C /Users/oscarpetrikas/focus-lock commit -m "feat(shared): unblock_specific kind + RequestUnblock IPC types"
```

---

### Task 10: C# Models mirror (`daemon-win`)

**Files:**
- Modify: `daemon-win/FocusLock.Daemon/Models/*.cs` (find the file(s) defining `LockRule` and add the new kind)

- [ ] **Step 1: Read the existing models** to find where the `Kind` enum or union string is declared.

```bash
grep -rn "block_now\|unblock_all" /Users/oscarpetrikas/focus-lock/daemon-win/FocusLock.Daemon/Models/ | head
```

- [ ] **Step 2: Mirror the changes.** Add `unblock_specific` to the allowed kind values everywhere the existing `block_now`/`schedule`/`unblock_all` triple appears. Add a nullable `string? ExpiresAt` property to the `LockRule` DTO and ensure the JSON property name maps to `expires_at` (or `expiresAt` — match the existing case style of `target_apps` vs `targetApps`).

- [ ] **Step 3: Build to verify**

```bash
cd /Users/oscarpetrikas/focus-lock/daemon-win/FocusLock.Daemon && dotnet build -c Release 2>&1 | tail -10
```

Expected: `Build succeeded` with 0 errors.

- [ ] **Step 4: Commit**

```bash
git -C /Users/oscarpetrikas/focus-lock add daemon-win/FocusLock.Daemon/Models/
git -C /Users/oscarpetrikas/focus-lock commit -m "feat(daemon-win): mirror unblock_specific kind + expiresAt in models"
```

---

### Task 11: Swift Models mirror (`daemon-mac`)

**Files:**
- Modify: `daemon-mac/Sources/FocusLockDaemon/Models.swift`

- [ ] **Step 1: Read the existing struct.**

```bash
grep -n "block_now\|unblock_all" /Users/oscarpetrikas/focus-lock/daemon-mac/Sources/FocusLockDaemon/Models.swift
```

- [ ] **Step 2: Mirror the changes.** Add `unblock_specific` to the rule-kind enum (if it's a Swift `enum`) or to the validating decoder (if it's a string). Add a nullable `expiresAt: String?` (or `expires_at` per the existing case style) on the rule struct.

- [ ] **Step 3: Build to verify**

```bash
cd /Users/oscarpetrikas/focus-lock/daemon-mac && swift build -c release 2>&1 | tail -10
```

Expected: build succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
git -C /Users/oscarpetrikas/focus-lock add daemon-mac/Sources/FocusLockDaemon/Models.swift
git -C /Users/oscarpetrikas/focus-lock commit -m "feat(daemon-mac): mirror unblock_specific kind + expiresAt in models"
```

---

### Task 12: Mac `CronEvaluator` priority

**Files:**
- Modify: `daemon-mac/Sources/FocusLockDaemon/CronEvaluator.swift`

- [ ] **Step 1: Read the evaluator.**

```bash
cat /Users/oscarpetrikas/focus-lock/daemon-mac/Sources/FocusLockDaemon/CronEvaluator.swift
```

- [ ] **Step 2: Extend the priority chain.** Find where `unblock_all` is checked. For each "should this target be blocked?" evaluation, add a check just before `block_now`/`schedule` that returns "don't block" if any active rule with `kind == .unblockSpecific`:
  - is not expired (compare `expiresAt` to the current ISO timestamp; if `expiresAt` is nil it's treated as live, but the server filters these out so we shouldn't see them — defensive treat-as-live anyway), AND
  - has the target in its `targetApps` (for app-blocked evaluations) or `targetDomains` (for domain-blocked evaluations).

Priority order from highest to lowest:
1. `unblock_all` → don't block
2. `unblock_specific` matching the target → don't block (NEW)
3. `block_now` matching the target → block
4. `schedule` matching the target whose cron is currently active → block
5. Else → don't block

- [ ] **Step 3: Build to verify**

```bash
cd /Users/oscarpetrikas/focus-lock/daemon-mac && swift build -c release 2>&1 | tail -10
```

Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git -C /Users/oscarpetrikas/focus-lock add daemon-mac/Sources/FocusLockDaemon/CronEvaluator.swift
git -C /Users/oscarpetrikas/focus-lock commit -m "feat(daemon-mac): unblock_specific takes priority over block_now/schedule"
```

---

### Task 13: Win `CronEvaluator` priority

**Files:**
- Modify: `daemon-win/FocusLock.Daemon/Services/CronEvaluator.cs`

- [ ] **Step 1: Read the evaluator.**

```bash
cat /Users/oscarpetrikas/focus-lock/daemon-win/FocusLock.Daemon/Services/CronEvaluator.cs
```

- [ ] **Step 2: Extend the priority chain** with the same logic described in Task 12, mirrored in C#:
- Active `unblock_all` → don't block (existing).
- Active, unexpired `unblock_specific` whose `TargetApps` contains the app OR `TargetDomains` contains the domain → don't block (NEW).
- Else fall through to existing `block_now` / `schedule`.

For "unexpired": parse `ExpiresAt` if non-null and compare to `DateTime.UtcNow`. Treat a null `ExpiresAt` as still-live (server filters; defensive).

- [ ] **Step 3: Build to verify**

```bash
cd /Users/oscarpetrikas/focus-lock/daemon-win/FocusLock.Daemon && dotnet build -c Release 2>&1 | tail -10
```

Expected: `Build succeeded`.

- [ ] **Step 4: Commit**

```bash
git -C /Users/oscarpetrikas/focus-lock add daemon-win/FocusLock.Daemon/Services/CronEvaluator.cs
git -C /Users/oscarpetrikas/focus-lock commit -m "feat(daemon-win): unblock_specific takes priority over block_now/schedule"
```

---

### Task 14: Daemon IPC — `request_unblock` and `request_status` on both platforms

**Files:**
- Modify: `daemon-mac/Sources/FocusLockDaemon/FamilyService.swift`
- Modify: `daemon-win/FocusLock.Daemon/Services/FamilyService.cs`

- [ ] **Step 1: Mac side.** Read `FamilyService.swift` to find where other IPC requests are handled (e.g. `redeem_pairing_code`, `unpair`, etc.) and add two new handlers. The handlers should:
  - For `request_unblock`: send a `POST /api/v1/family/requests` to the family-server using the stored device JWT, with body `{ targetKind, target, requestedMinutes }`. Return the response `{ requestId, expiresAt }`.
  - For `request_status`: send a `GET /api/v1/device/requests/:id` using the same device JWT. Return `{ status, resolutionRuleExpiresAt }` where the latter is null unless the resolved rule's expiresAt is present.

- [ ] **Step 2: Mirror on the Win side** in `FamilyService.cs`. Same logic in C#.

- [ ] **Step 3: Build both**

```bash
cd /Users/oscarpetrikas/focus-lock/daemon-mac && swift build -c release 2>&1 | tail -5
cd /Users/oscarpetrikas/focus-lock/daemon-win/FocusLock.Daemon && dotnet build -c Release 2>&1 | tail -5
```

Expected: both build clean.

- [ ] **Step 4: Commit**

```bash
git -C /Users/oscarpetrikas/focus-lock add daemon-mac/Sources/FocusLockDaemon/FamilyService.swift daemon-win/FocusLock.Daemon/Services/FamilyService.cs
git -C /Users/oscarpetrikas/focus-lock commit -m "feat(daemons): IPC handlers for request_unblock + request_status"
```

---

## Phase C — UI (Tasks 15–20)

### Task 15: `familyApi.ts` — Notification kind + requests namespace

**Files:**
- Modify: `ui/src/lib/familyApi.ts`

- [ ] **Step 1: Extend the `Notification.kind` union** to include `'approval_request'`:

```typescript
export interface Notification {
  id: number;
  kind: 'weekly_digest' | 'device_paired' | 'approval_request';
  title: string;
  body: string;
  payload: unknown;
  readAt: string | null;
  createdAt: string;
}
```

- [ ] **Step 2: Add request types + namespace.** Below the existing `Notification` block:

```typescript
export interface ApprovalRequest {
  id: string;
  deviceId: string;
  targetKind: 'app' | 'domain';
  target: string;
  requestedMinutes: number;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  resolutionRuleId: string | null;
}
```

After the existing `family` namespace, add:

```typescript
// ── Approval Requests (Phase 3.2) ──────────────────────────────────────────

export const familyRequests = {
  getById: (token: string, id: string) =>
    request<{ request: ApprovalRequest }>(`/api/v1/family/requests/${id}`, { method: 'GET' }, token),

  approve: (token: string, id: string) =>
    request<{ request: ApprovalRequest; rule: LockRule }>(`/api/v1/family/requests/${id}/approve`,
      { method: 'POST' }, token),

  deny: (token: string, id: string) =>
    request<{ request: ApprovalRequest }>(`/api/v1/family/requests/${id}/deny`,
      { method: 'POST' }, token),
};
```

- [ ] **Step 3: Type-check**

```bash
cd /Users/oscarpetrikas/focus-lock/ui && npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git -C /Users/oscarpetrikas/focus-lock add ui/src/lib/familyApi.ts
git -C /Users/oscarpetrikas/focus-lock commit -m "feat(ui): familyRequests API client"
```

---

### Task 16: Store — approveRequest + denyRequest + hydration cache

**Files:**
- Modify: `ui/src/stores/family.ts`

- [ ] **Step 1: Extend the import** to add `familyRequests`, `ApprovalRequest`:

```typescript
import {
  account, auth, family, familyRequests, notifications as notificationsApi, FamilyApiError,
  type ApprovalRequest, type DeviceSummary, type LockRule, type Notification, type Session,
} from '../lib/familyApi';
```

- [ ] **Step 2: Add state** for hydrated requests (keyed by id, since notifications carry only the id in payload):

```typescript
  requestsById: Record<string, ApprovalRequest>;
```

Initial value: `requestsById: {}`. Add to `logout()` clear: `requestsById: {},`.

- [ ] **Step 3: Add actions:**

```typescript
  hydrateRequest(id: string): Promise<void>;
  approveRequest(id: string): Promise<void>;
  denyRequest(id: string): Promise<void>;
```

Implementations (next to `loadNotifications`):

```typescript
  async hydrateRequest(id) {
    const s = get().session;
    if (!s) return;
    if (get().requestsById[id]) return;   // already cached
    try {
      const { request } = await familyRequests.getById(s.token, id);
      set({ requestsById: { ...get().requestsById, [id]: request } });
    } catch (e) { console.warn('hydrateRequest failed', id, e); }
  },

  async approveRequest(id) {
    const s = get().session;
    if (!s) return;
    try {
      const { request } = await familyRequests.approve(s.token, id);
      set({ requestsById: { ...get().requestsById, [id]: request } });
    } catch (e) {
      if (e instanceof FamilyApiError && e.status === 409) {
        // Already resolved — refresh notifications so the card disappears.
        await get().loadNotifications();
      } else { console.warn('approveRequest failed', id, e); }
    }
  },

  async denyRequest(id) {
    const s = get().session;
    if (!s) return;
    try {
      const { request } = await familyRequests.deny(s.token, id);
      set({ requestsById: { ...get().requestsById, [id]: request } });
    } catch (e) {
      if (e instanceof FamilyApiError && e.status === 409) {
        await get().loadNotifications();
      } else { console.warn('denyRequest failed', id, e); }
    }
  },
```

- [ ] **Step 4: Type-check**

```bash
cd /Users/oscarpetrikas/focus-lock/ui && npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git -C /Users/oscarpetrikas/focus-lock add ui/src/stores/family.ts
git -C /Users/oscarpetrikas/focus-lock commit -m "feat(ui): approval-request store actions + hydration cache"
```

---

### Task 17: `FamilyInbox.tsx` — approval-request card variant

**Files:**
- Modify: `ui/src/components/FamilyInbox.tsx`

- [ ] **Step 1: Rewrite `NotificationCard`** to branch on kind. Read the existing file first; the function currently picks an icon and renders a small card. Extract the approval-request rendering into its own subcomponent:

```typescript
// (Add these imports at the top.)
import { useFamily } from '../stores/family';
import type { ApprovalRequest, Notification } from '../lib/familyApi';
```

Add a memoized hook for hydration + a card variant:

```typescript
function ApprovalRequestCard({ notification, request, onMarkRead }: {
  notification: Notification;
  request: ApprovalRequest | undefined;
  onMarkRead: () => void;
}): JSX.Element {
  const approveRequest = useFamily(s => s.approveRequest);
  const denyRequest    = useFamily(s => s.denyRequest);
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);

  // Inline countdown so the card disables its buttons when the 1-hour window
  // closes without forcing a poll.
  const expiresAt = request?.expiresAt ?? null;
  const secondsLeft = useCountdown(expiresAt);
  const isPending = (request?.status ?? 'pending') === 'pending' && secondsLeft > 0;

  async function approve() {
    if (busy) return;
    setBusy('approve');
    try { await approveRequest(request!.id); onMarkRead(); }
    finally { setBusy(null); }
  }
  async function deny() {
    if (busy) return;
    setBusy('deny');
    try { await denyRequest(request!.id); onMarkRead(); }
    finally { setBusy(null); }
  }

  if (!request) {
    return (
      <li className="border rounded-md p-3 border-border/50">
        <p className="text-sm text-text">{notification.title}</p>
        <p className="text-xs text-faint mt-1">Loading…</p>
      </li>
    );
  }

  return (
    <li className={cn(
      'border rounded-md p-3 transition-colors',
      isPending ? 'border-accent/40 bg-accent/5' : 'border-border/50',
    )}>
      <p className="text-sm font-medium text-text">{notification.title}</p>
      <p className="text-xs text-muted mt-1 leading-relaxed">{notification.body}</p>
      {isPending && (
        <>
          <p className="text-[11px] text-faint mt-2 tnum">Expires in {fmtCountdown(secondsLeft)}</p>
          <div className="flex gap-2 mt-2">
            <button onClick={approve} disabled={!!busy}
              className="btn-primary px-3 py-1.5 text-xs flex-1">
              {busy === 'approve' ? 'Working…' : 'Approve'}
            </button>
            <button onClick={deny} disabled={!!busy}
              className="btn-ghost px-3 py-1.5 text-xs flex-1">
              {busy === 'deny' ? 'Working…' : 'Deny'}
            </button>
          </div>
        </>
      )}
      {request.status === 'approved' && (
        <p className="text-xs text-success mt-2">✓ Approved · unblock active</p>
      )}
      {request.status === 'denied' && (
        <p className="text-xs text-faint mt-2">Denied</p>
      )}
      {request.status === 'expired' || (request.status === 'pending' && secondsLeft <= 0) ? (
        <p className="text-xs text-faint mt-2">Expired</p>
      ) : null}
    </li>
  );
}

function useCountdown(iso: string | null): number {
  const target = useMemo(() => iso ? Date.parse(iso) : 0, [iso]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!target) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [target]);
  return target ? Math.max(0, Math.floor((target - now) / 1000)) : 0;
}

function fmtCountdown(s: number): string {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
```

Add `useMemo` and `useState` to the React imports if not already there.

- [ ] **Step 2: Inside the existing `FamilyInbox` component**, before the render branch in the `notifications.map`, add hydration on mount for any approval-request notifications:

```typescript
  const requestsById = useFamily(s => s.requestsById);
  const hydrateRequest = useFamily(s => s.hydrateRequest);

  // Hydrate every approval_request notification we see, if not cached.
  useEffect(() => {
    for (const n of notifications) {
      if (n.kind === 'approval_request') {
        const id = (n.payload as { requestId?: string } | null)?.requestId;
        if (id && !requestsById[id]) hydrateRequest(id);
      }
    }
  }, [notifications, requestsById, hydrateRequest]);
```

Then dispatch by kind in the map:

```typescript
        {notifications.map(n => {
          if (n.kind === 'approval_request') {
            const id = (n.payload as { requestId?: string } | null)?.requestId;
            const req = id ? requestsById[id] : undefined;
            return <ApprovalRequestCard key={n.id} notification={n}
              request={req}
              onMarkRead={() => markRead(n.id)} />;
          }
          return <NotificationCard key={n.id} notification={n} onMarkRead={() => markRead(n.id)} />;
        })}
```

- [ ] **Step 3: Type-check + manual run.**

```bash
cd /Users/oscarpetrikas/focus-lock/ui && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git -C /Users/oscarpetrikas/focus-lock add ui/src/components/FamilyInbox.tsx
git -C /Users/oscarpetrikas/focus-lock commit -m "feat(ui): approval-request card variant in FamilyInbox"
```

---

### Task 18: `useNewRequestAlerts` hook + Settings toggle

**Files:**
- Create: `ui/src/components/useNewRequestAlerts.ts`
- Modify: `ui/src/pages/Family.tsx` (mount the hook)

- [ ] **Step 1: Write the hook**

```typescript
import { useEffect, useRef } from 'react';
import { useFamily } from '../stores/family';

const SEEN_KEY = 'focus-lock:approval-request-last-seen';
const ENABLED_KEY = 'focus-lock:approval-request-notify-enabled';

function isEnabled(): boolean {
  const raw = localStorage.getItem(ENABLED_KEY);
  return raw === null ? true : raw === '1';
}

/// Watches the Family Inbox for new `approval_request` notifications and
/// fires a desktop notification on the FIRST sight of each one. Idempotent
/// across reloads via a localStorage seen-marker keyed on the newest
/// notification id we've alerted on.
export function useNewRequestAlerts(active: boolean): void {
  const notifications = useFamily(s => s.notifications);
  const requestsById  = useFamily(s => s.requestsById);
  const seenRef = useRef<number>(0);

  useEffect(() => {
    const raw = localStorage.getItem(SEEN_KEY);
    seenRef.current = raw ? Number(raw) || 0 : 0;
  }, []);

  useEffect(() => {
    if (!active || !isEnabled()) return;
    if (notifications.length === 0) return;

    let highest = seenRef.current;
    for (const n of notifications) {
      if (n.kind !== 'approval_request') continue;
      if (n.id <= seenRef.current) continue;
      const reqId = (n.payload as { requestId?: string } | null)?.requestId;
      const req = reqId ? requestsById[reqId] : undefined;
      if (!req || req.status !== 'pending') continue;

      if ('Notification' in window && Notification.permission === 'granted') {
        try { new Notification(n.title, { body: n.body, silent: false }); }
        catch { /* ignore */ }
      }
      if (n.id > highest) highest = n.id;
    }
    if (highest > seenRef.current) {
      seenRef.current = highest;
      localStorage.setItem(SEEN_KEY, String(highest));
    }
  }, [active, notifications, requestsById]);
}

/// Toggle exported for the Settings page (separate task).
export function setApprovalRequestNotificationsEnabled(on: boolean): void {
  localStorage.setItem(ENABLED_KEY, on ? '1' : '0');
}
export function getApprovalRequestNotificationsEnabled(): boolean {
  return isEnabled();
}
```

- [ ] **Step 2: Mount the hook in `Family.tsx`.** Inside `function Family()`, alongside the existing `useTamperAlerts(...)` line:

```typescript
import { useNewRequestAlerts } from '../components/useNewRequestAlerts';
// ... already imports above ...

  useNewRequestAlerts(!!session);
```

(Active only when there's a parent session.)

- [ ] **Step 3: Type-check**

```bash
cd /Users/oscarpetrikas/focus-lock/ui && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git -C /Users/oscarpetrikas/focus-lock add ui/src/components/useNewRequestAlerts.ts ui/src/pages/Family.tsx
git -C /Users/oscarpetrikas/focus-lock commit -m "feat(ui): OS notification for new approval requests"
```

---

### Task 19: Child-side "Ask for N min" buttons

**Files:**
- Modify: `ui/src/pages/Family.tsx`
- Modify: `ui/src/stores/daemon.ts` (add a `requestUnblock` action)
- Modify: `ui/src-tauri/src/lib.rs` (Tauri command bridge — if the daemon store helper goes through it)

- [ ] **Step 1: Find how existing IPC calls reach the daemon.** Look at how `redeemFamilyCode` or `setFirewallLockdown` is wired in `ui/src/stores/daemon.ts`. The store wraps a `request(type, payload)` helper which calls Tauri's `invoke('ipc_request', { type, payload })`. We reuse that — the daemon receives a JSON message and forwards to the family-server.

- [ ] **Step 2: Add to the daemon store.** In `ui/src/stores/daemon.ts`, add an action:

```typescript
  requestUnblock: (target: string, targetKind: 'app' | 'domain', minutes: 5 | 15 | 30 | 60) =>
    request<{ requestId: string; expiresAt: string }>('request_unblock',
      { target, targetKind, minutes }),
```

(Match the existing pattern. The exact return-type generic and helper name may need to match what the store already uses — read the file first.)

- [ ] **Step 3: Render the buttons in `ChildPairedView`.** Find the existing `family.activeRules.map(r => ...)` block. For each rule, add a small picker + ask button:

```typescript
{family.activeRules.map(r => (
  <li key={r.id} className="border border-border/50 rounded-md p-2 text-xs space-y-2">
    {/* ... existing rule rendering ... */}
    {(r.targetApps.length === 1 || r.targetDomains.length === 1) && (
      <AskUnblockRow
        targetKind={r.targetApps.length === 1 ? 'app' : 'domain'}
        target={r.targetApps[0] ?? r.targetDomains[0]}
      />
    )}
  </li>
))}
```

Then add the `AskUnblockRow` component below `ChildPairedView`:

```typescript
function AskUnblockRow({ targetKind, target }: { targetKind: 'app' | 'domain'; target: string }) {
  const requestUnblock = useDaemon(s => s.requestUnblock);
  const [minutes, setMinutes] = useState<5 | 15 | 30 | 60>(15);
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [status, setStatus] = useState<'pending' | 'approved' | 'denied' | 'expired' | null>(null);

  async function ask() {
    setBusy(true);
    try {
      const res = await requestUnblock(target, targetKind, minutes);
      setRequestId(res.requestId);
      setStatus('pending');
    } catch (e) { console.warn('requestUnblock failed', e); }
    finally { setBusy(false); }
  }

  // Poll status every 5s while pending — same shape as the inbox-card timer.
  const requestStatus = useDaemon(s => s.requestStatus);
  useEffect(() => {
    if (!requestId || status !== 'pending') return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await requestStatus(requestId);
        if (!cancelled) setStatus(r.status);
      } catch { /* ignore */ }
    };
    const t = window.setInterval(tick, 5000);
    return () => { cancelled = true; window.clearInterval(t); };
  }, [requestId, status, requestStatus]);

  if (status === 'approved') return <p className="text-success">✓ Approved — unblock active</p>;
  if (status === 'denied') return <p className="text-faint">Denied by parent.</p>;
  if (status === 'expired') return <p className="text-faint">No reply — try again later.</p>;
  if (status === 'pending') return <p className="text-accent">Waiting for parent…</p>;

  return (
    <div className="flex items-center gap-2">
      <select value={minutes} onChange={e => setMinutes(Number(e.target.value) as 5 | 15 | 30 | 60)}
        className="input-base px-2 py-1 text-xs">
        <option value={5}>5 min</option>
        <option value={15}>15 min</option>
        <option value={30}>30 min</option>
        <option value={60}>60 min</option>
      </select>
      <button onClick={ask} disabled={busy} className="btn-primary px-2 py-1 text-xs">
        {busy ? 'Asking…' : `Ask for ${minutes}m`}
      </button>
    </div>
  );
}
```

Also add a `requestStatus` action to the daemon store mirroring `requestUnblock`:

```typescript
  requestStatus: (requestId: string) =>
    request<{ status: 'pending' | 'approved' | 'denied' | 'expired';
              resolutionRuleExpiresAt: string | null }>('request_status', { requestId }),
```

- [ ] **Step 4: Type-check**

```bash
cd /Users/oscarpetrikas/focus-lock/ui && npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git -C /Users/oscarpetrikas/focus-lock add ui/src/pages/Family.tsx ui/src/stores/daemon.ts
git -C /Users/oscarpetrikas/focus-lock commit -m "feat(ui): ChildPairedView ask-for-N-min buttons + daemon store actions"
```

---

### Task 20: Ship 1.4.0

**Files:**
- Modify: `ui/package.json`, `ui/src-tauri/tauri.conf.json` (1.3.0 → 1.4.0)
- Modify: `landing/changelog.html` (add 1.4.0 entry)
- Modify: `docs/family-controls-status.md` (Phase 3.2 row)

- [ ] **Step 1: Bump versions.** Change `"version": "1.3.0"` → `"version": "1.4.0"` in both `ui/package.json` and `ui/src-tauri/tauri.conf.json`.

- [ ] **Step 2: Add the changelog entry.** Insert a new `<article>` at the top of the timeline in `landing/changelog.html` (above the existing "Coming next" roadmap entry — and convert that roadmap entry from a "Roadmap" badge to a "shipped" follow-up by removing it, since the feature has now actually shipped):

```html
    <!-- ───── 2026-06-09 (latest) ───── -->
    <article class="entry" data-type="app">
      <div class="entry-meta">
        <div class="entry-date">June 9, 2026</div>
        <span class="badge app">App</span>
        <span class="version-tag">1.4.0</span>
      </div>
      <div class="entry-body">
        <h2>Kids ask, parents approve — Family Approval Requests are live</h2>
        <ul>
          <li><strong>Kid taps "Ask for N min" on any active block.</strong> 5 / 15 / 30 / 60-minute options. The parent sees a card in the Family Inbox with one-tap <em>Approve</em> or <em>Deny</em>, and a desktop notification fires the moment it arrives.</li>
          <li><strong>Approvals lift the block for just that one thing, for just that long.</strong> Approving "reddit.com for 15 min" lifts reddit.com for 15 minutes — everything else stays blocked. When the timer hits zero, the block re-engages automatically.</li>
          <li><strong>Asks expire after an hour.</strong> If nobody answers in an hour, the request quietly expires — no stale "yes" 6 hours later. The kid sees "No reply — try again later."</li>
          <li><strong>No emails.</strong> Lives in the Inbox we shipped last week. One surface for everything family-related.</li>
        </ul>
      </div>
    </article>
```

Remove the existing 2026-06-09 "Coming next" roadmap entry — it's now shipped.

- [ ] **Step 3: Update `docs/family-controls-status.md`.** Add a row to the "What's done" table:

```markdown
| Phase 3.2 — Family Approval Requests (kid asks, parent approves; time-limited unblock_specific rule) | ✅ | `family-server/src/approvalRequests.ts`, migrations 0005/0006, per-minute cron; `daemon-{win,mac}` evaluator + IPC; `ui/src/components/FamilyInbox.tsx` card variant + `useNewRequestAlerts.ts`; child UI in `ui/src/pages/Family.tsx` | shipped in v1.4.0 |
```

- [ ] **Step 4: Apply migrations + deploy worker.**

```bash
cd /Users/oscarpetrikas/focus-lock/family-server
npm run db:migrate:remote
npm run deploy
```

Expected: both migrations apply; worker deploys; both crons registered.

- [ ] **Step 5: Build the UI.**

```bash
cd /Users/oscarpetrikas/focus-lock/ui
VITE_FAMILY_API_URL=https://focuslock-family.oscarpetrikas.workers.dev npm run tauri build
```

Expected: build completes (the updater-signing error at the end is harmless without `TAURI_SIGNING_PRIVATE_KEY`).

- [ ] **Step 6: Install locally.**

```bash
osascript -e 'tell application "FocusLock" to quit' 2>&1
sleep 2
rm -rf /Applications/FocusLock.app
cp -R /Users/oscarpetrikas/focus-lock/ui/src-tauri/target/release/bundle/macos/FocusLock.app /Applications/
xattr -d com.apple.quarantine /Applications/FocusLock.app 2>/dev/null
open -a /Applications/FocusLock.app
defaults read /Applications/FocusLock.app/Contents/Info.plist CFBundleShortVersionString
```

Expected: prints `1.4.0`.

- [ ] **Step 7: Commit, push, PR, merge, tag.**

```bash
git -C /Users/oscarpetrikas/focus-lock add ui/package.json ui/src-tauri/tauri.conf.json \
  landing/changelog.html docs/family-controls-status.md
git -C /Users/oscarpetrikas/focus-lock commit -m "chore(release): 1.4.0 — Family Approval Requests"

# Push the branch
BRANCH=$(git -C /Users/oscarpetrikas/focus-lock rev-parse --abbrev-ref HEAD)
git -C /Users/oscarpetrikas/focus-lock push -u origin "$BRANCH"

# Open PR (subagent should pause here so the user can review + merge from
# the GitHub UI; tagging happens AFTER merge into main).
gh pr create --base main --head "$BRANCH" --title "v1.4.0 — Family Approval Requests" --body "$(cat <<'EOF'
## Summary

Phase 3.2 — kid hits a block, picks a duration (5/15/30/60), parent approves or denies from the Inbox card with one tap. Approval creates a time-limited `unblock_specific` rule that lifts the block for that one thing, then re-engages automatically.

- New D1 table `approval_requests` + `lock_rules.expires_at` column.
- Server: 5 new endpoints (kid create/poll, parent hydrate/approve/deny) + per-minute cron sweeps overdue pending → expired.
- Daemons (Win + Mac): new `unblock_specific` rule kind with `expires_at` takes priority over `block_now` / `schedule` for matching targets; self-expires on the next tick.
- Parent UI: Inbox card variant with Approve/Deny + live countdown; desktop notification on first sight.
- Child UI: "Ask for N min" buttons next to each active family rule in `ChildPairedView`.

Block-intercept page changes are deferred to a 1.4.1 follow-up.

## Test plan

- [ ] On a paired child device, hit "Ask for 15 min" on an active block.
- [ ] Parent device: confirm desktop notification fires and a card appears in the Family Inbox.
- [ ] Tap Approve. Confirm the block lifts on the child device within ~5 seconds.
- [ ] Wait 15 min (or set requested_minutes to 1 for quick test). Confirm block re-engages automatically.
- [ ] Tap Deny on a second request. Confirm child sees "Denied by parent."
- [ ] Don't answer for 1 hour. Confirm request flips to expired and child sees the message.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Stop here — the user should review + merge. After merge, on the user's signal, run:

```bash
git -C /Users/oscarpetrikas/focus-lock checkout main
git -C /Users/oscarpetrikas/focus-lock pull origin main
git -C /Users/oscarpetrikas/focus-lock tag v1.4.0
git -C /Users/oscarpetrikas/focus-lock push origin v1.4.0
```

That tag fires `release.yml` and ships signed installers.

---

## Self-review

**Spec coverage:**
- approval_requests table → Task 1 ✓
- lock_rules.expires_at → Task 2 ✓
- New types + extended unions → Task 3 ✓
- DB helpers (createApprovalRequest, findById, findPendingByTarget, markResolved, expireOverdue) → Task 4 ✓
- 5 HTTP endpoints → Tasks 5, 6 ✓
- Per-minute cron sweep → Task 7 ✓
- End-to-end server gate → Task 8 ✓
- shared/protocol.ts → Task 9 ✓
- C# Models mirror → Task 10 ✓
- Swift Models mirror → Task 11 ✓
- Daemon evaluator priority → Tasks 12, 13 ✓
- Daemon IPC handlers → Task 14 ✓
- familyApi extension → Task 15 ✓
- Store actions → Task 16 ✓
- Inbox card variant → Task 17 ✓
- useNewRequestAlerts hook + settings → Task 18 ✓
- ChildPairedView ask flow + Tauri bridge → Task 19 ✓
- Ship → Task 20 ✓

**Gaps:**
- **Block-intercept page changes** — explicitly deferred per the plan header.
- **Account DO for parent WS push** — explicitly deferred per the plan header. Parent UI polls every 60s already.
- **Settings page toggle UI** — the hook supports a localStorage toggle, but no Settings page UI is added. That's a small follow-up; the default is "on" and the toggle key is documented for power users.

**Placeholder scan:** No `TBD`, `TODO`, "similar to Task N", or "fill in details" inside task bodies. Daemon tasks (10–14) intentionally reference reading the existing file pattern rather than handing the subagent a verbatim file — these involve unique-per-platform syntax (C# attributes, Swift Codable) that's better discovered than dictated. Subagents that hit unfamiliar territory should report BLOCKED rather than guess.

**Type consistency:**
- `unblock_specific` literal: matches across `protocol.ts`, `types.ts`, `db.ts`, `familyApi.ts`, and the daemon mirrors.
- `expiresAt` (camelCase) used in TS, `expires_at` (snake_case) at the SQL + row layer — convention matches existing `created_at` / `createdAt` split.
- `approval_request` notification kind: present in `types.ts` server, `familyApi.ts` client, `FamilyInbox.tsx`, and `useNewRequestAlerts.ts`.
- API namespace `familyRequests` (Task 15) → store calls in Task 16 → component calls in Task 17. Consistent.
- Daemon IPC type strings `request_unblock` / `request_status`: Task 14 (handler) ↔ Task 19 (UI caller). Match.
