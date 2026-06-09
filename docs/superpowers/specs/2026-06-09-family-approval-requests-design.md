# Family Approval Requests — Design

**Status:** Brainstormed, awaiting user review.
**Phase:** 3.2 (follows 3.1 Family Inbox).
**Date:** 2026-06-09

## What this is

Child-initiated, parent-resolved unblock requests. The kid hits a block, picks a duration (5/15/30/60 min), the parent gets an OS notification + Inbox card with one-click **Approve** / **Deny**. Approval creates a time-limited rule that lifts the block for that ONE app or domain for the requested window, then re-engages. This is the headline pricing-justification feature for Family Controls and the natural next consumer of the Inbox plumbing from 3.1.

## Locked product decisions

| Decision | Choice |
|---|---|
| Trigger surfaces | Block-intercept page **and** Family tab on child machine |
| Request scope | Just the single thing the kid tried — one app OR one domain |
| Duration | Kid picks 5/15/30/60 min at request time (no parent override) |
| Pending lifetime | 1-hour cutoff; auto-expires after that |
| Rate limit | None (parent gets every ask) |
| Parent notify | OS notification on first sight + persistent Inbox card |

## Architecture

The 3.1 Inbox carries the parent-facing UX; the new mechanics live mostly in the daemon and one small server table + lock_rules extension.

### New D1 table — `approval_requests`

One row per kid ask. Migration `0005_approval_requests.sql`.

```sql
CREATE TABLE approval_requests (
  id                  TEXT PRIMARY KEY,          -- UUID v4
  account_id          TEXT NOT NULL,
  device_id           TEXT NOT NULL,
  target_kind         TEXT NOT NULL,             -- 'app' | 'domain'
  target              TEXT NOT NULL,             -- e.g. 'reddit.com' or 'Discord'
  requested_minutes   INTEGER NOT NULL,          -- 5 | 15 | 30 | 60
  status              TEXT NOT NULL,             -- 'pending' | 'approved' | 'denied' | 'expired'
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,             -- created_at + 1h
  resolved_at         TEXT,                      -- when status left 'pending'
  resolution_rule_id  TEXT,                      -- FK to lock_rules row on 'approved'
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (device_id)  REFERENCES devices(id)  ON DELETE CASCADE
);

CREATE INDEX idx_appr_account_status  ON approval_requests(account_id, status, created_at DESC);
CREATE INDEX idx_appr_pending_expiry  ON approval_requests(status, expires_at);
```

The `notifications.kind` enum gains a third variant `'approval_request'` with payload `{ requestId: string }`. The Inbox card hydrates by reading the request row through the API.

### `lock_rules` extension

Migration `0006_lock_rule_expires_at.sql`: add nullable `expires_at TEXT` column to `lock_rules`. NULL for everything except the new `unblock_specific` kind.

The kind enum gains `'unblock_specific'`. Mirrored across:
- `shared/protocol.ts` (TS source of truth).
- `daemon-win/.../Models/` (C# mirror).
- `daemon-mac/.../Models.swift` (Swift mirror).

Server `listActiveRulesForDevice` adds `AND (expires_at IS NULL OR expires_at > ?)` to the WHERE so a stale rule never reaches the daemon.

### Server endpoints

```
POST   /api/v1/family/requests              (device-auth)
POST   /api/v1/family/requests/:id/approve  (parent-auth)
POST   /api/v1/family/requests/:id/deny     (parent-auth)
GET    /api/v1/device/requests/:id          (device-auth)  — poll endpoint for the block page
GET    /api/v1/family/requests/:id          (parent-auth)  — hydration for Inbox cards
```

`POST /requests` write path:

1. Verify device JWT.
2. If an existing `pending` row matches `(device_id, target_kind, target)`, return that row (idempotent retry).
3. Else insert new row with `expires_at = now + 1h`, status `pending`.
4. Insert a `notifications` row with `kind='approval_request'`, `payload={requestId}`, title `"<hostname> wants <target> for Nm"`, body restating the ask.
5. Push WS notify to parent's account-scoped channel (NEW — see below).

`POST /requests/:id/approve` write path:

1. Verify parent JWT, scope to row's `account_id`.
2. Atomic: only proceed if status is still `pending` and `expires_at > now`; else return `409 expired` (or 409 with current status).
3. Insert new `lock_rules` row: `kind='unblock_specific'`, `target_apps` or `target_domains` set per the request's `target_kind`, `expires_at = now + requested_minutes`, `active=1`.
4. Update `approval_requests`: status `approved`, `resolved_at=now`, `resolution_rule_id`.
5. Push the new rule to the device WS (reuse existing `notifyDevice` `rule_change`).
6. Return the created rule so the parent Inbox can render "Approved · expires in 15m" without a second roundtrip.

`POST /requests/:id/deny`: same scoping, sets status `denied`, `resolved_at=now`. Pushes `request_resolved` over WS so the child block page learns the verdict without polling out.

### Parent WS channel

The 3.1 status doc flagged "WS push doesn't reach the parent UI" as a known TODO. This feature needs it for live request arrival. Two viable shapes:

- **Account Durable Object** — one DO per `account_id`, holds the parent-side WebSocket. Symmetric with `DEVICE_CONN`.
- **Reuse devices DO** — server iterates `devices` for the account and pushes through each. Wrong direction.

We pick the **Account DO** path. New class `AccountConnection` in `do.ts`. `POST /requests` calls into it after the DB write. If no parent WS is connected, the push is dropped silently (the next poll picks it up). A new `[[durable_objects.bindings]]` entry plus a Cloudflare DO-migration tag (`new_sqlite_classes = ["AccountConnection"]`) gets added to `wrangler.toml` — no D1 migration file.

If the implementation reveals AccountConnection is more than ~150 lines, we drop it from this plan and keep parent on polling — it's not load-bearing for correctness, just freshness. Decision deferred to plan-writing time.

### Cron expiry sweep

`* * * * *` — every minute. Reads `approval_requests` where `status='pending' AND expires_at < now`, flips to `expired`, and pushes `request_resolved` over WS for any block page polling. Lives in the same `scheduled` handler as the weekly digest, dispatched by inspecting `controller.cron`.

## Parent flow (UI)

Reuses everything from 3.1:

- **Inbox card variant** in `FamilyInbox.tsx` for `kind === 'approval_request'`. Card shows: device hostname, target, requested minutes, live countdown to expiry, **Approve** and **Deny** buttons. Single click each — the kid already picked the duration. Approved cards transition to a green "Approved · expires in 12m" state with the countdown driven by the returned rule's `expires_at`. Denied/expired cards fade out and auto-mark-read.
- **OS notification on first sight** — new `useNewRequestAlerts` hook mirroring `useTamperAlerts`. Watches the inbox poll for new `approval_request` items whose `createdAt` crosses a `localStorage` last-seen marker. Title: `"FocusLock — Sam wants reddit.com for 15 min"`. Body restates request. Click focuses the FocusLock window. No sound. Generalize the existing `fireTamperNotification` helper into a tiny `fireFamilyNotification(title, body)` so both hooks share it.
- **Store actions** added to `useFamily`: `approveRequest(id): Promise<void>`, `denyRequest(id): Promise<void>`. Optimistic flip locally, then sync. On `409 expired` from server, refresh the inbox and surface a small inline message on the card.
- **Settings page** — small toggle "Notify me about approval requests" (defaults on). Stored in `localStorage`; the hook honors it.

## Kid flow (UI + daemon)

### Block-intercept page

The daemon already serves a block page through `InterceptHttpService` (Win) / `InterceptHttpService.swift` (Mac). Both gain a "Why blocked?" panel with:

- One-line context: `Blocked by family rule.`
- 4 segmented-control buttons: `5m / 15m / 30m / 60m`.
- "Ask for unblock" button (disabled until a duration is picked).
- On submit: page POSTs to a new local-only daemon endpoint `POST /intercept/request-unblock` with `{kind, target, minutes}`. Daemon forwards via its device JWT to `POST /api/v1/family/requests`.
- After submit: page polls `GET /intercept/request-status/:id` every 5s (local; daemon proxies). On `approved` the page redirects to the original URL. On `denied` / `expired` it shows the verdict and offers an "Ask again" button.
- If the kid is blocked by a **profile/local rule** (not a family rule), the panel doesn't render — there's no parent to ask. Daemon decides this server-side based on which rule kind matched.

UI: monochrome, system fonts, no marketing copy. The page already exists; we're adding ~30 lines.

### Family tab on the child machine

The existing `ChildPairedView` in `Family.tsx` already renders an "Active family rules" list. Each row gains:

- A duration picker (5/15/30/60, default 15).
- An "Ask for N min" button.
- After submit, the row shows "Pending — waiting for parent" with a small countdown to expiry.

Same backend; same status flow.

### Local IPC

`shared/protocol.ts` gains two message types:

```typescript
type RequestUnblockReq = {
  type: 'request_unblock';
  target: string;
  targetKind: 'app' | 'domain';
  minutes: 5 | 15 | 30 | 60;
};
type RequestUnblockRes = { requestId: string; expiresAt: string };
type RequestStatusReq  = { type: 'request_status'; requestId: string };
type RequestStatusRes  = { status: 'pending'|'approved'|'denied'|'expired'; resolutionRuleExpiresAt: string | null };
```

C# and Swift Models mirrors follow.

The Tauri-bridge path (`ipc_request` in `ui/src-tauri/src/lib.rs`) routes both new request types through to the daemon. The intercept-page path hits the daemon's localhost HTTP server directly — no Tauri involved.

## Daemon enforcement

The trickiest part. Mirrored across `daemon-win` and `daemon-mac`.

### `unblock_specific` rule semantics

For each evaluation tick, for each target (app process name or domain):

- Collect all matching active rules with `expires_at` in the future or NULL.
- If any `unblock_all` is active → don't block (existing behavior).
- Else if any `unblock_specific` matches that target → don't block (NEW).
- Else if any `block_now` or applicable `schedule` matches → block (existing).
- Else → don't block.

Self-expiry: when `expires_at` is in the past, the rule no longer satisfies "active and unexpired," so the prior block re-engages automatically on the next tick. No cleanup pass needed locally. The server's `listActiveRulesForDevice` filter handles eventual consistency.

When a rule transitions from active → expired (the daemon notices via tick comparison), it fires a `family.rule_expired` audit row with `{ ruleId, target, requestId }` so the parent's activity log shows "Sam's 15-minute reddit unblock ended."

### Local HTTP endpoints

`InterceptHttpService` gains two routes (already runs on `127.0.0.1`):

```
POST /intercept/request-unblock           → forwards to family-server, returns { requestId, expiresAt }
GET  /intercept/request-status/:id        → forwards to server, returns { status, resolutionRuleExpiresAt }
```

These are bound to localhost only; no auth needed beyond that (an attacker on the machine has bigger problems).

## Failure modes — explicit

| Scenario | Behavior |
|---|---|
| Daemon offline when request arrives | Server writes the row + notification; parent can approve; daemon syncs on reconnect (existing flow for `block_now`) and applies the `unblock_specific` rule. If `expires_at` has passed by then, the rule never takes effect — fine. |
| Parent approves an expired request | `409 expired`. UI greys buttons proactively via the live countdown, so this is rare. |
| Parent denies after kid stops caring | Notification card stays in feed; OS notification doesn't re-fire on denial. |
| Two devices, same kid, same target | Each request is per-device; no cross-device behavior. |
| Kid retries same target while pending | Server returns existing `pending` row; intercept page just keeps polling. |
| Kid's daemon never gets the WS push (network flake) | Page polls `GET /api/v1/device/requests/:id` every 5s as fallback. WS is an optimization. |
| Family-server unreachable from daemon | Local HTTP endpoint returns 503; intercept page shows "Can't reach your family server right now — try again in a minute." |

## Out of scope

- **Parent overriding duration at approval time.** The kid picks. (Can be a Phase 3.3 setting if needed.)
- **Per-device or per-kid rate limits.** No-limit is the decision.
- **Multi-target requests.** One target per request.
- **Approval-request templates.** ("Always allow weekend reddit until 10pm.") That's a scheduling feature, not an approval feature.
- **SMS / email approval.** OS notification + in-app card only.

## What this builds on (3.1)

- `notifications` table → adds `'approval_request'` kind.
- `FamilyInbox` component → adds card variant; generalizes one helper.
- `useFamily` store → adds approve/deny actions.
- Family server REST + WS plumbing → adds endpoints and (new) parent-side WS DO.
- Weekly digest cron → gains a minute-granularity sweep for pending expiry.

## Open question for plan-writing

The Account DO for parent WS push is the only piece sized uncertainly. Plan-writing should include a checkpoint after attempting it; if it balloons past ~150 lines we drop it and parents fall back to the existing 60s inbox poll (3.1 already does this). Functionality is unchanged; only freshness suffers.
