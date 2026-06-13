# Approval Requests v1.4.1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a focused v1.4.1 release that tightens three policy knobs on the already-live Family Approval Requests feature (v1.4.0, June 10): drop the 5-minute preset, extend the pending window from 1 hour to 24 hours, and add anti-spam (one pending request per device + 10-minute cooldown after a deny on the same target).

**Architecture:** No schema change. Three constants + two new DB query helpers + new server-side pre-checks in `createRequestHandler` returning typed 409 codes (`pending_exists`, `deny_cooldown`). The TS protocol type becomes a discriminated union so the UI can branch on `ok`/`code`. Both daemons (Win + Mac) propagate the typed codes upward unchanged. The child UI's `AskUnblockRow` handles the two new rejection paths and disables itself when any sibling row already has a pending ask.

**Tech Stack:** Cloudflare Worker + D1 (TS), C# .NET 8 daemon, Swift 5.9 daemon, React 18 + Zustand + Tauri 2 (UI).

**Reference:** `docs/superpowers/specs/2026-06-12-approval-requests-v141-tightening-design.md`

**Scope guard:** no schema change, no new endpoints, no daemon-enforcement changes, no migration. If you find yourself reaching for any of those, stop and re-read the spec.

---

## File structure

**Modified (10 files):**
- `family-server/src/db.ts` — `APPR_REQUEST_TTL_MS` value; add `APPR_DENY_COOLDOWN_MS`; add 2 new query helpers.
- `family-server/src/approvalRequests.ts` — `ALLOWED_MINUTES` set; imports; pre-check branches in `createRequestHandler`; notification body copy.
- `family-server/src/types.ts` — `requestedMinutes` union narrowed.
- `shared/protocol.ts` — `minutes` union narrowed; `RequestUnblockResult` becomes a discriminated union.
- `daemon-win/FocusLock.Daemon/Models/FamilyMessages.cs` — `Minutes` comment; add `ConflictCode` + `PendingRequestId` + `RetryAfter` to `RequestUnblockResult`.
- `daemon-win/FocusLock.Daemon/Services/FamilyService.cs` — parse 409 body, return typed result instead of error string.
- `daemon-win/FocusLock.Daemon/IpcPipeService.cs` — minutes validation: drop 5.
- `daemon-mac/Sources/FocusLockDaemon/Models.swift` — `RequestUnblockResult` gains conflict fields.
- `daemon-mac/Sources/FocusLockDaemon/FamilyService.swift` — parse 409 body, return typed result.
- `daemon-mac/Sources/FocusLockDaemon/PipeServer.swift` (or wherever IPC dispatch lives) — minutes validation: drop 5.
- `ui/src/stores/daemon.ts` — `requestUnblock` signature + body; do NOT throw on `ok: false`.
- `ui/src/pages/Family.tsx` — `AskUnblockRow` minute union + presets + rejection-state branches + `anyPendingOnDevice` prop.
- `ui/package.json` — version `1.4.0` → `1.4.1`.
- `landing/changelog.html` — new top-of-timeline entry.
- `CHANGELOG.md` (root) — v1.4.1 section.

**No files created.** Every change targets a live file at a known location.

---

## Task 1: Worker — narrow `ALLOWED_MINUTES` to `[15, 30, 60]`

**Files:**
- Modify: `family-server/src/approvalRequests.ts:24`
- Modify: `family-server/src/approvalRequests.ts:54-56`
- Modify: `family-server/src/types.ts` (find `requestedMinutes` field, narrow union)

- [ ] **Step 1: Narrow the runtime set.**

In `family-server/src/approvalRequests.ts` line 24, replace:

```typescript
const ALLOWED_MINUTES = new Set([5, 15, 30, 60]);
```

with:

```typescript
const ALLOWED_MINUTES = new Set([15, 30, 60]);
```

- [ ] **Step 2: Update the validation error message.**

In the same file around line 54–56, replace:

```typescript
if (!ALLOWED_MINUTES.has(Number(body.requestedMinutes))) {
  return badRequest('requestedMinutes must be 5, 15, 30, or 60');
}
```

with:

```typescript
if (!ALLOWED_MINUTES.has(Number(body.requestedMinutes))) {
  return badRequest('requestedMinutes must be 15, 30, or 60');
}
```

- [ ] **Step 3: Narrow the TS type in `types.ts`.**

Find the `CreateApprovalRequestBody` interface (search `requestedMinutes:`). The field's annotation is currently `5 | 15 | 30 | 60`. Change it to `15 | 30 | 60`.

- [ ] **Step 4: Type-check.**

```bash
cd /Users/oscarpetrikas/focus-lock/family-server && npx tsc --noEmit
```

Expected: no new errors. The two known pre-existing errors (`src/devices.ts(6,53)` unused `LockRule`, `src/do.ts(15,11)` unused `state`) may still appear — that's fine.

- [ ] **Step 5: Commit.**

```bash
git -C /Users/oscarpetrikas/focus-lock add \
  family-server/src/approvalRequests.ts \
  family-server/src/types.ts
git -C /Users/oscarpetrikas/focus-lock commit -m "feat(family-server): drop 5-minute preset from approval requests"
```

---

## Task 2: Worker — extend pending TTL to 24h + add deny-cooldown constant + new helpers

**Files:**
- Modify: `family-server/src/db.ts:339` (constant)
- Modify: `family-server/src/db.ts` (add 2 helpers after `findPendingApprovalForTarget`)

- [ ] **Step 1: Change `APPR_REQUEST_TTL_MS` to 24 hours and export a deny-cooldown constant.**

In `family-server/src/db.ts` line 339, replace:

```typescript
const APPR_REQUEST_TTL_MS = 60 * 60 * 1000;   // 1 hour pending window
```

with:

```typescript
const APPR_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;   // 24-hour pending window
export const APPR_DENY_COOLDOWN_MS = 10 * 60 * 1000;   // 10-min re-ask cooldown after a deny
```

- [ ] **Step 2: Add the two new query helpers.**

Find `findPendingApprovalForTarget` (around line 376). Immediately after the closing `}` of that function, insert:

```typescript
/// Anti-spam (v1.4.1): true if any pending request exists on this device.
/// Used to enforce "one pending per device at a time" — the kid can only
/// have one open ask before it resolves or expires. Mirrors the
/// expires_at filter the cron sweep applies, so a stale row that the
/// sweep hasn't flipped yet doesn't count.
export async function findAnyPendingForDevice(
  db: D1Database, deviceId: string,
): Promise<ApprovalRequestRow | null> {
  const now = new Date().toISOString();
  const row = await db.prepare(
    `SELECT * FROM approval_requests
     WHERE device_id = ? AND status = 'pending' AND expires_at > ?
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(deviceId, now).first();
  return row as ApprovalRequestRow | null;
}

/// Anti-spam (v1.4.1): most recent denied row for this exact (device, target)
/// since `sinceIso`. Caller computes `sinceIso = now - APPR_DENY_COOLDOWN_MS`
/// and treats a non-null result as a cooldown hit. Returning the row
/// (not just a boolean) lets the handler compute `retryAfter` from
/// `resolved_at + APPR_DENY_COOLDOWN_MS`.
export async function findRecentDenialForTarget(
  db: D1Database, deviceId: string, targetKind: 'app' | 'domain',
  target: string, sinceIso: string,
): Promise<ApprovalRequestRow | null> {
  const row = await db.prepare(
    `SELECT * FROM approval_requests
     WHERE device_id = ? AND target_kind = ? AND target = ?
       AND status = 'denied' AND resolved_at > ?
     ORDER BY resolved_at DESC LIMIT 1`,
  ).bind(deviceId, targetKind, target, sinceIso).first();
  return row as ApprovalRequestRow | null;
}
```

- [ ] **Step 3: Type-check.**

```bash
cd /Users/oscarpetrikas/focus-lock/family-server && npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 4: Commit.**

```bash
git -C /Users/oscarpetrikas/focus-lock add family-server/src/db.ts
git -C /Users/oscarpetrikas/focus-lock commit -m "feat(family-server): 24h TTL + anti-spam helpers for approval requests"
```

---

## Task 3: Worker — wire the anti-spam pre-checks into `createRequestHandler`

**Files:**
- Modify: `family-server/src/approvalRequests.ts` (imports + handler body + notification copy)

- [ ] **Step 1: Extend the imports.**

Replace the import block at lines 12–22 with:

```typescript
import {
  APPR_DENY_COOLDOWN_MS,
  createApprovalRequest, createNotification, createRule, findApprovalRequestById,
  findAnyPendingForDevice, findPendingApprovalForTarget,
  findRecentDenialForTarget, markApprovalResolved,
} from './db';
import type {
  ApprovalRequest, ApprovalRequestRow, CreateApprovalRequestBody, Env,
} from './types';
import {
  badRequest, clientIp, conflict, json, notFound,
  requireAuth, requireDeviceAuth, safeJson, unauthorized,
} from './utils';
```

`conflict` is still imported because `approveRequestHandler` and `denyRequestHandler` keep using it. Only the new code paths emit the structured 409 inline.

- [ ] **Step 2: Replace the body of `createRequestHandler` from the dedup comment downward.**

In `createRequestHandler` (currently lines 43–80), find the section starting with the `// Dedup: ...` comment. Replace from that comment through the closing `}` of the function with:

```typescript
  // 1) Idempotent same-target retry: if a pending row matches exactly, return it.
  //    This MUST run before the anti-spam checks, otherwise a flaky retry on the
  //    same target trips its own `pending_exists`.
  const existing = await findPendingApprovalForTarget(env.DB, ctx.deviceId, body.targetKind, target);
  if (existing) return json({ request: toApi(existing) });

  // 2) Anti-spam (v1.4.1): one pending per device at a time, across all targets.
  //    Inline a structured 409 instead of conflict() so the UI gets a typed
  //    `code` discriminant — conflict() only carries a string message.
  const anyPending = await findAnyPendingForDevice(env.DB, ctx.deviceId);
  if (anyPending) {
    return json({
      error: 'pending_exists',
      code: 'pending_exists',
      pendingRequestId: anyPending.id,
    }, 409);
  }

  // 3) Anti-spam (v1.4.1): 10-min cooldown after a deny on this exact target.
  const sinceIso = new Date(Date.now() - APPR_DENY_COOLDOWN_MS).toISOString();
  const recentDeny = await findRecentDenialForTarget(
    env.DB, ctx.deviceId, body.targetKind, target, sinceIso,
  );
  if (recentDeny && recentDeny.resolved_at) {
    const retryAfter = new Date(
      Date.parse(recentDeny.resolved_at) + APPR_DENY_COOLDOWN_MS,
    ).toISOString();
    return json({
      error: 'deny_cooldown',
      code: 'deny_cooldown',
      retryAfter,
    }, 409);
  }

  const row = await createApprovalRequest(
    env.DB, ctx.accountId, ctx.deviceId, body.targetKind, target, Number(body.requestedMinutes),
  );

  // Hydrate hostname so the notification title is human-readable.
  const dev = await env.DB.prepare('SELECT hostname FROM devices WHERE id = ?')
    .bind(ctx.deviceId).first<{ hostname: string | null }>();
  const host = dev?.hostname ?? 'A device';

  await createNotification(
    env.DB, ctx.accountId, 'approval_request',
    `${host} wants ${target} for ${row.requested_minutes}m`,
    `Approve or deny in the Family Inbox. Asks expire after 24 hours.`,
    { requestId: row.id },
  ).catch((err: unknown) => { console.warn('approval notification failed', err); });

  return json({ request: toApi(row) });
}
```

- [ ] **Step 3: Type-check.**

```bash
cd /Users/oscarpetrikas/focus-lock/family-server && npx tsc --noEmit
```

Expected: no new errors. If `clientIp` becomes unused, leave it — it's used by `approveRequestHandler`/`denyRequestHandler` further down the file (don't remove it).

- [ ] **Step 4: Commit.**

```bash
git -C /Users/oscarpetrikas/focus-lock add family-server/src/approvalRequests.ts
git -C /Users/oscarpetrikas/focus-lock commit -m "feat(family-server): anti-spam pre-checks in createRequestHandler"
```

---

## Task 4: Worker — smoke gate (local dev server)

This task verifies the three new behaviours against a live local worker before touching daemon code.

**Files:**
- No edits. Read-only verification.

- [ ] **Step 1: Start the local worker.**

```bash
cd /Users/oscarpetrikas/focus-lock/family-server && npm run dev &
WPID=$!
sleep 4
```

Expected: server listening on `http://127.0.0.1:8787`.

- [ ] **Step 2: Pair a test device.**

Use the existing dev-mode pairing helper or follow the README's `family-server` curl walkthrough to obtain a parent token (`$TOKEN`) and a device token (`$DEV_TOKEN`). Set `BASE=http://127.0.0.1:8787`.

- [ ] **Step 3: Confirm the 5-minute preset is rejected.**

```bash
curl -s -X POST $BASE/api/v1/family/requests \
  -H "authorization: Bearer $DEV_TOKEN" -H "content-type: application/json" \
  -d '{"target":"reddit.com","targetKind":"domain","requestedMinutes":5}' \
  -w "\n[status: %{http_code}]\n"
```

Expected: `400` with body containing `"requestedMinutes must be 15, 30, or 60"`.

- [ ] **Step 4: Successful 15-minute ask.**

```bash
RID=$(curl -s -X POST $BASE/api/v1/family/requests \
  -H "authorization: Bearer $DEV_TOKEN" -H "content-type: application/json" \
  -d '{"target":"reddit.com","targetKind":"domain","requestedMinutes":15}' \
  | jq -r '.request.id')
echo "RID=$RID"
```

Expected: a UUID. The row's `expires_at` is now + 24h.

- [ ] **Step 5: `pending_exists` rejection on a different target while one is pending.**

```bash
curl -s -X POST $BASE/api/v1/family/requests \
  -H "authorization: Bearer $DEV_TOKEN" -H "content-type: application/json" \
  -d '{"target":"twitter.com","targetKind":"domain","requestedMinutes":15}' \
  -w "\n[status: %{http_code}]\n"
```

Expected: `409` with body containing `"code":"pending_exists"` and `"pendingRequestId":"<RID>"`.

- [ ] **Step 6: Idempotent same-target retry still succeeds.**

```bash
curl -s -X POST $BASE/api/v1/family/requests \
  -H "authorization: Bearer $DEV_TOKEN" -H "content-type: application/json" \
  -d '{"target":"reddit.com","targetKind":"domain","requestedMinutes":15}' \
  | jq '.request.id'
```

Expected: prints the same `$RID` as Step 4. Not a 409.

- [ ] **Step 7: Deny the request, then verify cooldown.**

```bash
curl -s -X POST $BASE/api/v1/family/requests/$RID/deny \
  -H "authorization: Bearer $TOKEN" -w "\n[status: %{http_code}]\n"

curl -s -X POST $BASE/api/v1/family/requests \
  -H "authorization: Bearer $DEV_TOKEN" -H "content-type: application/json" \
  -d '{"target":"reddit.com","targetKind":"domain","requestedMinutes":15}' \
  -w "\n[status: %{http_code}]\n"
```

Expected: first call `200`. Second call `409` with body containing `"code":"deny_cooldown"` and a `"retryAfter"` ISO timestamp ~10 min in the future.

- [ ] **Step 8: A *different* target after the deny is allowed (cooldown is per-target).**

```bash
curl -s -X POST $BASE/api/v1/family/requests \
  -H "authorization: Bearer $DEV_TOKEN" -H "content-type: application/json" \
  -d '{"target":"twitter.com","targetKind":"domain","requestedMinutes":30}' \
  -w "\n[status: %{http_code}]\n"
```

Expected: `200`. The deny on `reddit.com` does NOT block a fresh ask on `twitter.com`.

- [ ] **Step 9: Stop the local worker.**

```bash
kill $WPID 2>/dev/null; wait $WPID 2>/dev/null
```

No commit — verification only.

---

## Task 5: Shared protocol — narrow minutes + discriminated `RequestUnblockResult`

**Files:**
- Modify: `shared/protocol.ts:376-385`

- [ ] **Step 1: Narrow the minutes union and convert `RequestUnblockResult` to a discriminated `type`.**

In `shared/protocol.ts`, find the block:

```typescript
export interface RequestUnblockPayload {
  target: string;
  targetKind: "app" | "domain";
  minutes: 5 | 15 | 30 | 60;
}

export interface RequestUnblockResult {
  requestId: string;
  expiresAt: string;
}
```

Replace it with:

```typescript
export interface RequestUnblockPayload {
  target: string;
  targetKind: "app" | "domain";
  minutes: 15 | 30 | 60;
}

/**
 * v1.4.1: either the request was created (`ok: true`, server returned a row),
 * or the server's anti-spam pre-checks rejected it. The UI pattern-matches on
 * `ok` and surfaces a tailored message per `code`.
 *
 * The daemon propagates the typed payload from the worker's 409 body
 * unchanged — it does NOT raise an exception for these two states.
 */
export type RequestUnblockResult =
  | { ok: true;  requestId: string; expiresAt: string }
  | { ok: false; code: "pending_exists"; pendingRequestId: string }
  | { ok: false; code: "deny_cooldown"; retryAfter: string };  // ISO timestamp
```

- [ ] **Step 2: Type-check the workspace.**

```bash
cd /Users/oscarpetrikas/focus-lock/ui && npx tsc --noEmit
```

Expected: errors in `ui/src/stores/daemon.ts` (`requestUnblock` is typed to the OLD shape) and `ui/src/pages/Family.tsx` (`5 | 15 | 30 | 60`). These will be fixed in Tasks 8 and 9 — for now confirm those are the ONLY new errors (i.e. the workspace types correctly except for the two call sites we'll update).

- [ ] **Step 3: Commit.**

```bash
git -C /Users/oscarpetrikas/focus-lock add shared/protocol.ts
git -C /Users/oscarpetrikas/focus-lock commit -m "feat(shared): narrow minutes; RequestUnblockResult discriminated union"
```

---

## Task 6: Windows daemon — narrow minutes + propagate typed 409 codes

**Files:**
- Modify: `daemon-win/FocusLock.Daemon/Models/FamilyMessages.cs:138`
- Modify: `daemon-win/FocusLock.Daemon/Models/FamilyMessages.cs:141-145`
- Modify: `daemon-win/FocusLock.Daemon/Services/FamilyService.cs:199-213`
- Modify: `daemon-win/FocusLock.Daemon/IpcPipeService.cs:539`

- [ ] **Step 1: Update the `Minutes` comment and extend `RequestUnblockResult` with conflict fields.**

In `daemon-win/FocusLock.Daemon/Models/FamilyMessages.cs`, replace lines 134–145 with:

```csharp
public sealed class RequestUnblockPayload
{
    public string Target     { get; set; } = string.Empty;
    public string TargetKind { get; set; } = string.Empty;   // "app" | "domain"
    public int    Minutes    { get; set; }                   // 15 | 30 | 60
}

public sealed class RequestUnblockResult
{
    // Success case: requestId + expiresAt are populated, ConflictCode is null.
    public string  RequestId { get; set; } = string.Empty;
    public string  ExpiresAt { get; set; } = string.Empty;

    // v1.4.1 — Anti-spam conflict case: ConflictCode is "pending_exists" or
    // "deny_cooldown". Exactly one of PendingRequestId / RetryAfter is set
    // per code. UI branches on ConflictCode.
    public string? ConflictCode      { get; set; }
    public string? PendingRequestId  { get; set; }
    public string? RetryAfter        { get; set; }
}
```

- [ ] **Step 2: Special-case the 409 body in `RequestUnblockAsync`.**

In `daemon-win/FocusLock.Daemon/Services/FamilyService.cs`, find the block at lines 199–213 (the `if (!resp.IsSuccessStatusCode)` clause and the success return). Replace it with:

```csharp
        if ((int)resp.StatusCode == 409)
        {
            // v1.4.1 typed conflict — parse the structured body and bubble up.
            try
            {
                var conflict = await resp.Content
                    .ReadFromJsonAsync<RequestUnblockConflictBody>(JsonOpts, ct)
                    .ConfigureAwait(false);
                if (conflict?.Code == "pending_exists" || conflict?.Code == "deny_cooldown")
                {
                    return (null, new RequestUnblockResult
                    {
                        ConflictCode     = conflict.Code,
                        PendingRequestId = conflict.PendingRequestId,
                        RetryAfter       = conflict.RetryAfter,
                    });
                }
            }
            catch
            {
                // Fall through to the generic-error path on parse failure.
            }
        }

        if (!resp.IsSuccessStatusCode)
        {
            var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            return ($"Request failed ({(int)resp.StatusCode}): {body}", null);
        }

        var env = await resp.Content.ReadFromJsonAsync<RequestEnvelope>(JsonOpts, ct).ConfigureAwait(false);
        if (env?.Request == null || string.IsNullOrEmpty(env.Request.Id))
            return ("Server returned an invalid response", null);

        return (null, new RequestUnblockResult
        {
            RequestId = env.Request.Id,
            ExpiresAt = env.Request.ExpiresAt,
        });
    }
```

Then add the conflict-body DTO at the end of `FamilyService.cs`, just before the closing `}` of the class (or in `Models/FamilyMessages.cs` if you prefer to keep DTOs grouped — the location doesn't matter):

```csharp
    private sealed class RequestUnblockConflictBody
    {
        public string? Code             { get; set; }
        public string? PendingRequestId { get; set; }
        public string? RetryAfter       { get; set; }
    }
```

- [ ] **Step 3: Drop the 5-minute validation in `IpcPipeService.HandleRequestUnblock`.**

In `daemon-win/FocusLock.Daemon/IpcPipeService.cs` line 539, replace:

```csharp
        if (payload.Minutes != 5 && payload.Minutes != 15 && payload.Minutes != 30 && payload.Minutes != 60)
            return IpcResponse.Error("minutes must be 5, 15, 30, or 60");
```

with:

```csharp
        if (payload.Minutes != 15 && payload.Minutes != 30 && payload.Minutes != 60)
            return IpcResponse.Error("minutes must be 15, 30, or 60");
```

- [ ] **Step 4: Build.**

```bash
cd /Users/oscarpetrikas/focus-lock/daemon-win/FocusLock.Daemon && dotnet build -c Release
```

Expected: build succeeds, no new warnings about unused symbols. If `RequestUnblockConflictBody` isn't found in `FamilyService.cs` after editing, make sure you added the inner class inside the `FamilyService` class brace.

- [ ] **Step 5: Commit.**

```bash
git -C /Users/oscarpetrikas/focus-lock add \
  daemon-win/FocusLock.Daemon/Models/FamilyMessages.cs \
  daemon-win/FocusLock.Daemon/Services/FamilyService.cs \
  daemon-win/FocusLock.Daemon/IpcPipeService.cs
git -C /Users/oscarpetrikas/focus-lock commit -m "feat(daemon-win): drop 5-min preset; propagate v1.4.1 conflict codes"
```

---

## Task 7: macOS daemon — mirror of Task 6

**Files:**
- Modify: `daemon-mac/Sources/FocusLockDaemon/Models.swift` (the `RequestUnblockResult` struct + Minutes comment if present)
- Modify: `daemon-mac/Sources/FocusLockDaemon/FamilyService.swift:177-227` (the `requestUnblock` function)
- Modify: `daemon-mac/Sources/FocusLockDaemon/PipeServer.swift` or wherever `request_unblock` is dispatched (search for `request_unblock` and the `minutes` validation; mirror the Win change)

- [ ] **Step 1: Find the Mac dispatch site.**

```bash
grep -nE 'request_unblock|"minutes"|minutes == 5|minutes \!= 5' /Users/oscarpetrikas/focus-lock/daemon-mac/Sources/FocusLockDaemon/*.swift
```

Use the file the grep points at for Step 4's validation change (Mac daemon's IPC dispatch is in a different file from the network call). If no validation is present today on the Mac side, skip Step 4 — the worker rejects 5-min anyway and the Mac side has only the network forwarder.

- [ ] **Step 2: Extend `RequestUnblockResult` in `Models.swift`.**

Find the `RequestUnblockResult` struct. Currently it's:

```swift
struct RequestUnblockResult: Codable {
    let requestId: String
    let expiresAt: String
}
```

Replace with:

```swift
/// v1.4.1: either a freshly-created request (success), or a typed anti-spam
/// conflict from the family-server. `conflictCode` is nil on success.
/// Exactly one of `pendingRequestId` / `retryAfter` is set per code.
struct RequestUnblockResult: Codable {
    let requestId: String      // empty on conflict
    let expiresAt: String      // empty on conflict

    let conflictCode:     String?   // "pending_exists" | "deny_cooldown" | nil
    let pendingRequestId: String?
    let retryAfter:       String?

    init(requestId: String, expiresAt: String,
         conflictCode: String? = nil,
         pendingRequestId: String? = nil,
         retryAfter: String? = nil) {
        self.requestId        = requestId
        self.expiresAt        = expiresAt
        self.conflictCode     = conflictCode
        self.pendingRequestId = pendingRequestId
        self.retryAfter       = retryAfter
    }
}
```

The default-value `init` keeps every other caller of `RequestUnblockResult(requestId:expiresAt:)` working without changes — only the network forwarder will set the conflict fields.

- [ ] **Step 3: Parse 409 bodies in `FamilyService.swift` `requestUnblock`.**

In `daemon-mac/Sources/FocusLockDaemon/FamilyService.swift` find the `guard (200..<300).contains(http.statusCode) else { ... }` block at line ~214. Replace it with:

```swift
            if http.statusCode == 409 {
                struct ConflictBody: Decodable {
                    var code: String?
                    var pendingRequestId: String?
                    var retryAfter: String?
                }
                if let body = data,
                   let conflict = try? JSONDecoder().decode(ConflictBody.self, from: body),
                   let code = conflict.code,
                   code == "pending_exists" || code == "deny_cooldown" {
                    resultPayload = nil
                    resultErr = nil
                    sem.signal()
                    // Bail early with a typed RequestUnblockResult instead of an error string.
                    // Sentinel pattern: signal first, then we'll detect the conflict outside the
                    // dataTask completion by checking `conflictResult`.
                    conflictResult = RequestUnblockResult(
                        requestId: "", expiresAt: "",
                        conflictCode: code,
                        pendingRequestId: conflict.pendingRequestId,
                        retryAfter: conflict.retryAfter,
                    )
                    return
                }
            }
            guard (200..<300).contains(http.statusCode) else {
                let bodyStr = (data.flatMap { String(data: $0, encoding: .utf8) }) ?? ""
                resultErr = "Request failed (\(http.statusCode)): \(bodyStr)"; return
            }
```

Add a `var conflictResult: RequestUnblockResult?` declaration alongside `resultErr` / `resultPayload` above the `URLSession.shared.dataTask` line, and update the final return-block at the end of `requestUnblock` to check it:

```swift
        if let conflictResult = conflictResult { return (nil, conflictResult) }
        if let resultErr = resultErr { return (resultErr, nil) }
        guard let env = resultPayload else { return ("Server returned no body", nil) }
        return (nil, RequestUnblockResult(requestId: env.request.id, expiresAt: env.request.expiresAt))
```

- [ ] **Step 4: Drop 5-min validation if present.**

If Step 1's grep found a Mac-side validation block like `minutes != 5 && minutes != 15 && minutes != 30 && minutes != 60`, change it to `minutes != 15 && minutes != 30 && minutes != 60` and adjust the error string. If no Mac-side validation exists, the worker is the source of truth and this step is a no-op.

- [ ] **Step 5: Build.**

```bash
cd /Users/oscarpetrikas/focus-lock/daemon-mac && swift build -c release
```

Expected: build succeeds.

- [ ] **Step 6: Commit.**

```bash
git -C /Users/oscarpetrikas/focus-lock add daemon-mac/Sources/FocusLockDaemon/
git -C /Users/oscarpetrikas/focus-lock commit -m "feat(daemon-mac): drop 5-min preset; propagate v1.4.1 conflict codes"
```

---

## Task 8: UI store — `requestUnblock` returns the discriminated result without throwing

**Files:**
- Modify: `ui/src/stores/daemon.ts:100-108` (interface)
- Modify: `ui/src/stores/daemon.ts:366-372` (implementation)

- [ ] **Step 1: Import the new result type.**

At the top of `ui/src/stores/daemon.ts`, find the existing `@shared/protocol` import (if any) or the local protocol re-export. Add `RequestUnblockResult` to the import list. If the file doesn't currently import from `@shared/protocol`, add:

```typescript
import type { RequestUnblockResult } from '@shared/protocol';
```

near the top of the imports.

- [ ] **Step 2: Update the interface.**

Replace lines 100–108 with:

```typescript
  /// Kid-initiated request to lift a specific block for a fixed window.
  /// v1.4.1: returns a discriminated result — `ok: true` with `requestId`
  /// on success, or `ok: false` with a typed `code` on an anti-spam reject.
  /// Throws only on genuine transport/server errors (5xx, network), NOT on
  /// the 409 conflicts which are part of the typed contract.
  requestUnblock(target: string, targetKind: 'app' | 'domain',
                 minutes: 15 | 30 | 60):
    Promise<RequestUnblockResult>;
  /// Poll the verdict on a previously-created request.
  requestStatus(requestId: string):
    Promise<{ status: 'pending' | 'approved' | 'denied' | 'expired';
              resolutionRuleExpiresAt: string | null }>;
```

- [ ] **Step 3: Update the implementation.**

Replace the existing `async requestUnblock(target, targetKind, minutes) { ... }` body at lines 366–372 with:

```typescript
  async requestUnblock(target, targetKind, minutes) {
    const res = await request('request_unblock', { target, targetKind, minutes });
    if (res.type !== 'request_unblock_result' || !res.payload) {
      throw new Error('Unexpected response from daemon');
    }
    const p = res.payload as {
      requestId?: string; expiresAt?: string;
      conflictCode?: string; pendingRequestId?: string; retryAfter?: string;
    };
    if (p.conflictCode === 'pending_exists' && p.pendingRequestId) {
      return { ok: false, code: 'pending_exists', pendingRequestId: p.pendingRequestId };
    }
    if (p.conflictCode === 'deny_cooldown' && p.retryAfter) {
      return { ok: false, code: 'deny_cooldown', retryAfter: p.retryAfter };
    }
    if (!p.requestId || !p.expiresAt) {
      throw new Error('Unexpected response from daemon');
    }
    return { ok: true, requestId: p.requestId, expiresAt: p.expiresAt };
  },
```

- [ ] **Step 4: Type-check.**

```bash
cd /Users/oscarpetrikas/focus-lock/ui && npx tsc --noEmit
```

Expected: errors now only in `ui/src/pages/Family.tsx` (the `AskUnblockRow` minute union + `res.requestId` access). Task 9 fixes those.

- [ ] **Step 5: Commit.**

```bash
git -C /Users/oscarpetrikas/focus-lock add ui/src/stores/daemon.ts
git -C /Users/oscarpetrikas/focus-lock commit -m "feat(ui/store): requestUnblock returns discriminated result"
```

---

## Task 9: UI `AskUnblockRow` — drop 5-min, handle two reject codes, `anyPendingOnDevice` mirror

**Files:**
- Modify: `ui/src/pages/Family.tsx:262` (call site — pass new prop)
- Modify: `ui/src/pages/Family.tsx:1202-1278` (component body)

- [ ] **Step 1: Replace the `AskUnblockRow` component body.**

Replace lines 1202–1278 with:

```tsx
// ── AskUnblockRow ────────────────────────────────────────────────────────────
// Kid-initiated "ask for N min" control rendered inline under a single-target
// block_now/schedule rule. v1.4.1 surfaces two server-side anti-spam rejects
// (pending_exists, deny_cooldown) and disables itself when a sibling row on
// the same device already has a pending ask.

function AskUnblockRow({ targetKind, target, anyPendingOnDevice }: {
  targetKind: 'app' | 'domain';
  target: string;
  /** v1.4.1: true when ANY row on this device already has a pending ask.
   *  Disables the Ask button — mirrors the server's `pending_exists` rule
   *  client-side so the kid doesn't tap into a guaranteed 409. */
  anyPendingOnDevice: boolean;
}): JSX.Element {
  const requestUnblock = useDaemon(s => s.requestUnblock);
  const requestStatus  = useDaemon(s => s.requestStatus);
  const [minutes, setMinutes] = useState<15 | 30 | 60>(15);
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [status, setStatus] = useState<
    'pending' | 'approved' | 'denied' | 'expired' | null
  >(null);
  /** v1.4.1: when the row is in `denied`, the ISO timestamp at which the kid
   *  can re-ask (resolved_at + 10 min). Null in every other state. */
  const [cooldownUntil, setCooldownUntil] = useState<string | null>(null);
  /** v1.4.1: server-side rejection message for pending_exists. The
   *  deny_cooldown reject is rendered via the `denied` status branch
   *  instead, since the visual treatment matches. */
  const [rejection, setRejection] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function ask(): Promise<void> {
    if (busy) return;
    setBusy(true); setError(null); setRejection(null);
    try {
      const res = await requestUnblock(target, targetKind, minutes);
      if (res.ok) {
        setRequestId(res.requestId);
        setStatus('pending');
      } else if (res.code === 'pending_exists') {
        setRejection('You already have a pending request. Wait for your parent to answer.');
      } else if (res.code === 'deny_cooldown') {
        setCooldownUntil(res.retryAfter);
        setStatus('denied');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach parent');
    } finally { setBusy(false); }
  }

  // Poll every 5s while pending. Stops as soon as we get a verdict.
  useEffect(() => {
    if (!requestId || status !== 'pending') return;
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const r = await requestStatus(requestId);
        if (!cancelled && r.status !== 'pending') setStatus(r.status);
      } catch { /* ignore transient errors */ }
    };
    const t = window.setInterval(tick, 5000);
    return () => { cancelled = true; window.clearInterval(t); };
  }, [requestId, status, requestStatus]);

  // v1.4.1: auto-recover from a denied row once the 10-min cooldown lapses.
  useEffect(() => {
    if (status !== 'denied' || !cooldownUntil) return;
    const ms = Date.parse(cooldownUntil) - Date.now();
    if (ms <= 0) { setStatus(null); setCooldownUntil(null); return; }
    const t = window.setTimeout(() => { setStatus(null); setCooldownUntil(null); }, ms);
    return () => window.clearTimeout(t);
  }, [status, cooldownUntil]);

  if (status === 'approved') {
    return <p className="text-success">✓ Approved — unblock active</p>;
  }
  if (status === 'denied') {
    const mins = cooldownUntil
      ? Math.max(1, Math.ceil((Date.parse(cooldownUntil) - Date.now()) / 60_000))
      : null;
    return (
      <p className="text-faint">
        Denied by parent. {mins ? `Ask again in ${mins} min.` : 'Ask again in a moment.'}
      </p>
    );
  }
  if (status === 'expired') {
    return <p className="text-faint">No reply in 24h — try again.</p>;
  }
  if (status === 'pending') {
    return <p className="text-accent">Waiting for parent…</p>;
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <select
          value={minutes}
          onChange={e => setMinutes(Number(e.target.value) as 15 | 30 | 60)}
          className="input-base px-2 py-1 text-xs">
          <option value={15}>15 min</option>
          <option value={30}>30 min</option>
          <option value={60}>60 min</option>
        </select>
        <button
          onClick={ask}
          disabled={busy || anyPendingOnDevice}
          title={anyPendingOnDevice ? 'One pending request at a time' : undefined}
          className="btn-primary px-2 py-1 text-xs">
          {busy ? 'Asking…' : `Ask for ${minutes}m`}
        </button>
        {error && <span className="text-danger">{error}</span>}
      </div>
      {rejection && <p className="text-faint text-xs">{rejection}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Pass `anyPendingOnDevice` at the call site.**

Find line 262 (current call site). Currently:

```tsx
<AskUnblockRow targetKind={single!.kind} target={single!.target} />
```

Locate the surrounding `ChildPairedView` (search upward for `function ChildPairedView` or `const ChildPairedView`). Just inside the component body — before the JSX `return` — derive the flag once:

```tsx
const anyPendingOnDevice = false;  // v1.4.1: see note below
```

Then pass it to `AskUnblockRow`:

```tsx
<AskUnblockRow
  targetKind={single!.kind}
  target={single!.target}
  anyPendingOnDevice={anyPendingOnDevice}
/>
```

**Note on `anyPendingOnDevice`:** the cleanest version of this flag lives in the daemon store (the store knows about every active `AskUnblockRow`'s `requestId`). For v1.4.1 we pass a literal `false` so each `AskUnblockRow` is independent; the server is still the source of truth and will reject duplicate-pending attempts with `pending_exists`, which the row renders gracefully. A follow-up (tracked in `docs/family-controls-status.md`) wires a real shared flag through the store. Do not block v1.4.1 on that — the `false` literal is correct for now.

- [ ] **Step 3: Type-check + dev build.**

```bash
cd /Users/oscarpetrikas/focus-lock/ui && npx tsc --noEmit
```

Expected: zero new errors.

```bash
cd /Users/oscarpetrikas/focus-lock/ui && npm run build
```

Expected: `tsc && vite build` completes with no errors.

- [ ] **Step 4: Commit.**

```bash
git -C /Users/oscarpetrikas/focus-lock add ui/src/pages/Family.tsx
git -C /Users/oscarpetrikas/focus-lock commit -m "feat(ui): AskUnblockRow handles 15/30/60 + v1.4.1 reject codes"
```

---

## Task 10: Release — version bump, changelog, smoke, tag, push

**Files:**
- Modify: `ui/package.json` (version)
- Modify: `landing/changelog.html` (new entry at top of timeline)
- Modify: `CHANGELOG.md` (root)

- [ ] **Step 1: Bump the UI app version.**

In `ui/package.json`, change:

```json
  "version": "1.4.0",
```

to:

```json
  "version": "1.4.1",
```

- [ ] **Step 2: Add the landing changelog entry.**

In `landing/changelog.html`, find the comment marker `<!-- ───── 2026-06-10 (latest) ───── -->` around line 230. Just BEFORE that line (so the new entry becomes the new "latest"), insert:

```html
    <!-- ───── 2026-06-12 (latest) ───── -->
    <article class="entry" data-type="app">
      <div class="entry-meta">
        <div class="entry-date">June 12, 2026</div>
        <span class="badge app">App</span>
        <span class="version-tag">1.4.1</span>
      </div>
      <div class="entry-body">
        <h2>Approval requests, tightened</h2>
        <ul>
          <li><strong>15 / 30 / 60 minute options.</strong> The 5-minute option is gone — five minutes was a fast doomscroll, not a real ask. The shortest exception is now 15 minutes, which makes "yes" mean something.</li>
          <li><strong>Parents get a full day to respond.</strong> Asks now stay open for 24 hours instead of expiring after one. If you're in meetings all morning, the kid's request is still waiting when you get back.</li>
          <li><strong>No more request spam.</strong> A kid can only have one open ask at a time. After a deny, the same target is on a 10-minute cooldown before they can re-ask — short enough that a real follow-up gets through quickly, long enough to make the kid pause.</li>
        </ul>
      </div>
    </article>

```

Also update the older 2026-06-10 entry (current "latest") to drop the (latest) marker from its comment — change `<!-- ───── 2026-06-10 (latest) ───── -->` to `<!-- ───── 2026-06-10 ───── -->`.

- [ ] **Step 3: Add the root `CHANGELOG.md` entry.**

At the top of `CHANGELOG.md`, immediately under any title/header but above the existing v1.4.0 entry, insert:

```markdown
## v1.4.1 — 2026-06-12

Policy tightening on Family Approval Requests:

- **Drop the 5-minute preset.** Duration options are now 15 / 30 / 60 minutes.
- **Extend the pending window to 24 hours** (was 1 hour). The cron sweep is unchanged.
- **Anti-spam:** one pending request per device at a time; after a deny on a target, the kid can't re-ask for that same target for 10 minutes. Server returns typed 409 codes (`pending_exists`, `deny_cooldown`); the child UI surfaces a friendly message and countdown.

No schema change. No new endpoints. Worker is backwards-compatible with v1.4.0 clients — older clients hitting the new rules see a generic error rather than the targeted UI; the auto-updater rolls them forward within a day.
```

- [ ] **Step 4: End-to-end smoke on a paired device pair.**

This needs a real paired parent + child setup. If you only have one machine, use two FocusLock identities and pair the second to the first as a "child."

Run through this sequence on the child machine's Family tab:

1. Pick a blocked single-target rule (e.g. `reddit.com`). Click "Ask for 15m". → Row should show `Waiting for parent…`.
2. On the parent device, deny the request from the Inbox card. → Child row flips to `Denied by parent. Ask again in 10 min.` with a real countdown number.
3. Try to re-ask the same target immediately. → Button is disabled? Wait. Click anyway after the countdown shows `0`. → Row should re-enable and accept the ask.
4. Re-ask reddit. While that's pending, find a second blocked target (e.g. `twitter.com`). Click its "Ask for 15m". → That row should immediately render `You already have a pending request. Wait for your parent to answer.` and not transition into Pending.
5. On the parent, approve the reddit ask. → Child row flips to `✓ Approved — unblock active`. The block lifts within ~5 seconds. The twitter row's Ask button (if you reload) is now available again.

Confirm each step matches. Note any deviation before proceeding.

- [ ] **Step 5: Commit the release artifacts.**

```bash
git -C /Users/oscarpetrikas/focus-lock add \
  ui/package.json \
  landing/changelog.html \
  CHANGELOG.md
git -C /Users/oscarpetrikas/focus-lock commit -m "chore(release): 1.4.1 — approval request policy tightening"
```

- [ ] **Step 6: Deploy the worker.**

```bash
cd /Users/oscarpetrikas/focus-lock/family-server && npm run deploy
```

Expected: deploy succeeds. Worker is now backwards-compatible — v1.4.0 clients keep working but will see the new 409 codes if they hit the new rules. The UI degrades to a generic error in that case, which is acceptable for a rolling release.

- [ ] **Step 7: Push the branch and open a PR.**

```bash
BRANCH=$(git -C /Users/oscarpetrikas/focus-lock rev-parse --abbrev-ref HEAD)
git -C /Users/oscarpetrikas/focus-lock push -u origin "$BRANCH"
gh pr create --base main --head "$BRANCH" --title "v1.4.1 — Approval Request Policy Tightening" --body "$(cat <<'EOF'
## Summary

Three small policy refinements on the v1.4.0 Family Approval Requests feature.

- Drop the 5-minute preset (15 / 30 / 60 only).
- Pending window: 1 hour → 24 hours.
- Anti-spam: one pending per device + 10-min deny cooldown on same target. Typed 409 codes (`pending_exists`, `deny_cooldown`) propagated through both daemons; child UI shows friendly messages with countdowns.

No DB migration. Worker is backwards-compatible with v1.4.0 clients.

## Test plan

- [x] Worker smoke gate (Task 4) — 5-min reject, idempotent retry, pending_exists, deny_cooldown all behave correctly.
- [x] End-to-end on a paired parent + child (Task 10 Step 4).
- [x] Win + Mac daemon builds clean.
- [x] UI `tsc --noEmit` + `npm run build` clean.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 8: After PR review + merge, tag and push.**

(Pause here so the user can review and merge from the GitHub UI. The tag fires `release.yml` and ships signed installers; don't tag until merge.)

```bash
git -C /Users/oscarpetrikas/focus-lock checkout main
git -C /Users/oscarpetrikas/focus-lock pull origin main
git -C /Users/oscarpetrikas/focus-lock tag v1.4.1
git -C /Users/oscarpetrikas/focus-lock push origin v1.4.1
```

---

## Self-review

**Spec coverage:**

- Drop 5-minute preset → Tasks 1, 5, 6, 7, 8, 9 ✓
- 1h → 24h pending → Task 2 ✓
- One-pending-per-device anti-spam → Tasks 2 (helper), 3 (handler), 5 (type), 6+7 (daemon), 8 (store), 9 (UI) ✓
- 10-min deny cooldown → same chain ✓
- Typed 409 codes through full stack → Tasks 3, 5, 6, 7, 8, 9 ✓
- Notification body copy update ("an hour" → "24 hours") → Task 3 ✓
- Backwards-compat with 1.4.0 clients → Task 10 Step 6 narrative ✓
- Changelog (per user rule) → Task 10 Steps 2–3 ✓
- Version bump → Task 10 Step 1 ✓
- Smoke gate before merging code paths together → Task 4 ✓
- End-to-end gate before tagging → Task 10 Step 4 ✓
- Deferred `anyPendingOnDevice` store flag → Task 9 Step 2 note ✓

**Gaps:**

- **No automated tests on the Worker.** Acknowledged by the spec's existing project-level TODO; not introduced by v1.4.1.
- **No reverse-compat test for v1.4.0 daemons hitting the v1.4.1 worker.** Mitigated by Task 10 Step 6's narrative and the fact that the new rules only fire if the v1.4.0 client violates them; the worker's response shape is a superset of the old one.

**Placeholder scan:** zero `TBD` / `TODO` / `???` / "similar to Task N" / "fill in details" inside task bodies. The single forward-looking deferral (the real `anyPendingOnDevice` flag) is explicitly scoped out with a note in Task 9 and a status-doc reference.

**Type consistency:**

- `RequestUnblockResult` is consistent across tasks: discriminated union in `shared/protocol.ts` (Task 5), C# struct with nullable conflict fields and superset semantics in Task 6, Swift struct with optional conflict fields in Task 7, propagated through the store unchanged in Task 8, consumed via `res.ok` / `res.code` discriminant in Task 9.
- The minutes union `15 | 30 | 60` matches across Task 1 (server), Task 5 (shared), Task 6 + 7 (daemon comments only — C# / Swift use `int` runtime), Task 8 (store), Task 9 (UI useState).
- The conflict-code strings `'pending_exists'` and `'deny_cooldown'` are spelled identically everywhere they appear.
