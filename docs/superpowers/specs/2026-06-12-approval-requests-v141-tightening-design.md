# Approval Requests v1.4.1 — Policy Tightening

**Status:** Brainstormed 2026-06-12, awaiting user review.
**Phase:** 3.2.1 — point-release refinement on the v1.4.0 ship.
**Date:** 2026-06-12

## What this is

Three small, focused policy refinements to the **already-shipped** Family Approval Requests feature (v1.4.0, June 10). The architecture, schema, endpoints, daemon enforcement, and UI surfaces all stay the same. We are changing three policy knobs and the typed errors / UI affordances that surround them.

This is not a new feature. It is a tightening pass.

## What shipped in v1.4.0 (baseline)

From `family-server/src/approvalRequests.ts` and `family-server/src/db.ts`:

| Knob | Live value |
|---|---|
| Entry point | Family tab on child's machine (block-page entry deferred to 3.2b) |
| Duration presets | 5 / 15 / 30 / 60 min |
| Pending lifetime (`APPR_REQUEST_TTL_MS`) | 1 hour |
| Anti-spam | Same-target dedup only (`findPendingApprovalForTarget`) — no global pending limit, no deny cooldown |

The feature works end-to-end. The refinements below address three rough edges, not bugs.

## The three changes

### Change 1 — Drop the 5-minute preset

**From:** `[5, 15, 30, 60]`  → **To:** `[15, 30, 60]`

**Why:** 5 minutes is enough time for a kid to start a doomscroll but not enough for any honest purpose ("five minutes on YouTube" is not a real ask). It also frames the feature as a stalling tactic. 15 minutes is the floor where the request feels intentional.

**Files affected:**
- `family-server/src/approvalRequests.ts`  — `ALLOWED_MINUTES = new Set([15, 30, 60])`
- `family-server/src/approvalRequests.ts`  — `badRequest('requestedMinutes must be 15, 30, or 60')`
- `family-server/src/types.ts`  — `requestedMinutes: 15 | 30 | 60`
- `shared/protocol.ts`  — `minutes: 15 | 30 | 60` on `RequestUnblockPayload`
- `daemon-win/.../Models/`  — C# validation mirror
- `daemon-mac/.../Models.swift`  — Swift validation mirror
- `ui/src/pages/Family.tsx`  — drop `<option value={5}>5 min</option>` from `AskUnblockRow`
- `ui/src/pages/Family.tsx`  — update `useState<5 | 15 | 30 | 60>` → `useState<15 | 30 | 60>`

### Change 2 — Extend pending lifetime to 24 hours

**From:** `APPR_REQUEST_TTL_MS = 60 * 60 * 1000`  → **To:** `APPR_REQUEST_TTL_MS = 24 * 60 * 60 * 1000`

**Why:** 1 hour assumes the parent is at the keyboard. Real life: kid asks at 8am, parent is in a meeting until 11. With a 1h window the ask expires before they see it, every ask becomes "no reply," and the feature feels broken. 24h gives the parent a full waking day. The cron sweep is unchanged — it still runs every minute and now flips rows after a longer dwell time.

**Files affected:**
- `family-server/src/db.ts` — constant value

That's it for code. UI copy ("Asks expire after an hour" → "Asks expire after 24 hours") shows up in two places:

- `family-server/src/approvalRequests.ts` — the notification body string passed to `createNotification`
- `ui/src/pages/Family.tsx` — the expired-status copy in `AskUnblockRow` ("No reply — try again later." stays fine; nothing to change there, the literal "1 hour" doesn't appear)

### Change 3 — Add anti-spam: one-pending + 10-min deny cooldown

**From:** Same-target dedup only. A kid can have N pending requests across N targets, and can re-ask immediately after a deny.

**To:** Two new server-side pre-checks before `createApprovalRequest`:

1. **One pending per device** — if any row exists for this `device_id` with `status='pending'` and `expires_at > now`, return `409 { code: 'pending_exists', pendingRequestId }`. The existing same-target dedup runs **first**, so a network-flake retry on the same target still returns the existing row idempotently rather than hitting `pending_exists`.

2. **Deny cooldown** — if a row exists for `(device_id, target_kind, target)` with `status='denied'` and `resolved_at > now - 10min`, return `409 { code: 'deny_cooldown', retryAfter }` where `retryAfter = resolved_at + 10min`.

**Why one-pending:** without it, a kid can fire 8 asks in 30 seconds and the parent's Inbox becomes spam. With it, the kid has to commit to one ask at a time.

**Why deny cooldown:** without it, "deny" is a non-event — kid immediately re-asks. 10 minutes is short enough that a genuine "I really need this" follow-up still gets through soon, long enough that the kid is forced to pause and reconsider. Not punitive; just a speed bump.

**Files affected:**
- `family-server/src/db.ts` — add `APPR_DENY_COOLDOWN_MS = 10 * 60 * 1000` (exported); add two new helpers:
  - `findAnyPendingForDevice(db, deviceId)` — `WHERE device_id = ? AND status = 'pending' AND expires_at > ?`
  - `findRecentDenialForTarget(db, deviceId, targetKind, target, sinceIso)` — `WHERE device_id = ? AND target_kind = ? AND target = ? AND status = 'denied' AND resolved_at > ?`
- `family-server/src/approvalRequests.ts` — import the new constant + helpers; in `createRequestHandler`, after the existing same-target dedup, run `pending_exists` check then `deny_cooldown` check; return structured 409 bodies (inline `json({ error, code, ... }, 409)` since `conflict()` only carries a string)
- `shared/protocol.ts` — turn `RequestUnblockResult` into a discriminated union:
  ```ts
  type RequestUnblockResult =
    | { ok: true;  requestId: string; expiresAt: string }
    | { ok: false; code: 'pending_exists'; pendingRequestId: string }
    | { ok: false; code: 'deny_cooldown'; retryAfter: string };
  ```
- `daemon-win/.../FamilyService.cs` — propagate the typed 409 body up to the IPC response without throwing
- `daemon-mac/.../FamilyService.swift` — same
- `ui/src/stores/daemon.ts` — `requestUnblock` returns `RequestUnblockResult` (does NOT throw on `ok: false`)
- `ui/src/pages/Family.tsx` — `AskUnblockRow` branches on the result:
  - `pending_exists` → show "You already have a pending request. Wait for your parent to answer."
  - `deny_cooldown` → render the row in `Denied — ask again in N min` state with the cooldown countdown from `retryAfter`
- `ui/src/pages/Family.tsx` — disable every other row's Ask button when any row on this device is pending (client-side mirror of the server rule; server is still source of truth)

### What we are NOT changing

- DB schema. No migration. The new helpers query existing columns.
- Architecture. Same endpoints, same cron, same daemon evaluator priority, same WS push.
- Approve/deny flow. Untouched.
- Out-of-scope items from the original spec stay out of scope (parent duration override, cancel endpoint, daily quotas, intercept-page entry).

## Rollout

1. Bump `ui/package.json` to `1.4.1`.
2. Worker deploys first (server is backwards-compatible — older clients still work; the new 409 codes only surface when an older client violates the new rules, which is fine since the existing same-target dedup will catch the most common retry case).
3. Daemons + UI ship on the v1.4.1 tag.

A 1.4.0 client talking to a 1.4.1 worker will get a 409 with the new `code` field if it trips the new rules. The 1.4.0 UI will surface a generic "request failed" message rather than the targeted one — acceptable degradation.

## Changelog entry (per user rule)

`landing/changelog.html` gets a v1.4.1 entry calling out the three changes in user-facing language ("we removed the 5-minute option, gave parents a full 24h to respond, and added a small cooldown so the Inbox doesn't get spammed").

## Failure modes — new ones to think about

| Scenario | Behavior |
|---|---|
| Kid has 1.4.0 client, hits 1.4.1 server with a 5-min ask | `400 badRequest('requestedMinutes must be 15, 30, or 60')`. UI shows generic error. Mitigation: ship the UI update before users notice. |
| Kid has 1.4.0 client (no anti-spam UI handling), hits `pending_exists` | Generic IPC error surfaces. Not great but not broken. Most kids on 1.4.0 will update via auto-updater within a day. |
| Pending row exists from 1.4.0 era (created with 1h TTL) | Row's `expires_at` is real, in the past. Cron flips it to `expired` on the next sweep tick. New asks proceed normally. No backfill needed. |
| Denied row from 1.4.0 era (no cooldown was enforced at the time) | `resolved_at` is real. If it's within 10min of now (rare — would need to deploy 1.4.1 within 10min of a v1.4.0 deny), the new cooldown applies retroactively. Acceptable. |

## Open questions

None. The decisions were locked in the 2026-06-12 brainstorm. The implementation surface is small enough that a plan can be written directly against these file lists.
