# FocusLock — Family Controls Server

Cloudflare Worker + D1 + Durable Objects backend for cross-device family controls (a parent on one device hard-locks apps on a child's device). **Phases 2.1–3.2 — auth, pairing, devices, rules, WebSocket, data portability, Family Inbox, approval requests.**

See [`docs/family-controls-design.md`](../docs/family-controls-design.md) for the full architecture and design decisions.

---

## Endpoint inventory

### Auth (Phase 2.1)

| Route                              | Method | Auth                | What it does                                       |
|------------------------------------|--------|---------------------|----------------------------------------------------|
| `/healthz`                         | GET    | none                | Liveness ping                                      |
| `/api/v1/auth/signup`              | POST   | none                | Create a parent account, return a session token    |
| `/api/v1/auth/login`               | POST   | none                | Verify email+password, return a session token      |
| `/api/v1/auth/refresh`             | POST   | Bearer (session)    | Issue a fresh 30-day session token                 |
| `/api/v1/auth/reset-request`       | POST   | none                | Email a reset token (currently logged to console)  |
| `/api/v1/auth/reset-confirm`       | POST   | none (reset tok in body) | Use a reset token to set a new password       |

### Family (Phase 2.2)

| Route                                                | Method | Auth             | What it does                                                                      |
|------------------------------------------------------|--------|------------------|-----------------------------------------------------------------------------------|
| `/api/v1/family/pair/create`                         | POST   | Bearer (session) | Generate a 6-digit pairing code, valid 10 minutes                                 |
| `/api/v1/family/pair/redeem`                         | POST   | none (code in body) | Consume a code; create the child device row; return a 1-year device-bound JWT |
| `/api/v1/family/devices`                             | GET    | Bearer (session) | List paired devices (with online status)                                          |
| `/api/v1/family/devices/:id`                         | DELETE | Bearer (session) | Unpair a device (deletes device row + cascades rules)                             |
| `/api/v1/family/devices/:id/rules`                   | POST   | Bearer (session) | Create a lock rule; pushes to child via WS if connected                           |
| `/api/v1/family/devices/:id/rules`                   | GET    | Bearer (session) | List active rules for a device                                                    |
| `/api/v1/family/devices/:id/rules/:ruleId`           | DELETE | Bearer (session) | Soft-delete a rule (sets `active = 0`); pushes to child                           |
| `/api/v1/device/rules`                               | GET    | Bearer (device)  | Child daemon pulls its own active rules (e.g. after reconnect)                    |
| `/api/v1/device/ws`                                  | GET    | Bearer (device)  | WebSocket upgrade — server-pushed rule changes + child heartbeat                  |

### Account data portability (Phase 2.7)

| Route                              | Method | Auth             | What it does                                                                      |
|------------------------------------|--------|------------------|-----------------------------------------------------------------------------------|
| `/api/v1/account/export`           | GET    | Bearer (session) | Download a JSON dump of the account row, devices, lock rules, and audit log       |
| `/api/v1/account`                  | DELETE | Bearer (session) | Hard-delete the account (cascades devices, rules, notifications, requests)        |

### Notifications — Family Inbox (Phase 3.1)

| Route                                          | Method | Auth             | What it does                                                                 |
|------------------------------------------------|--------|------------------|------------------------------------------------------------------------------|
| `/api/v1/notifications`                        | GET    | Bearer (session) | List inbox entries (paired/unpaired, offline-5min, cache-tampered, etc.)     |
| `/api/v1/notifications/:id/read`               | POST   | Bearer (session) | Mark one notification read                                                   |
| `/api/v1/notifications/read-all`               | POST   | Bearer (session) | Mark every notification read                                                 |

### Approval Requests (Phase 3.2)

| Route                                                 | Method | Auth             | What it does                                                                       |
|-------------------------------------------------------|--------|------------------|------------------------------------------------------------------------------------|
| `/api/v1/family/requests`                             | POST   | Bearer (device)  | Kid asks for a temporary unblock (15/30/60 min) on a target app or domain          |
| `/api/v1/family/requests/:id`                         | GET    | Bearer (session) | Parent reads the full request row (parent Inbox card hydration)                    |
| `/api/v1/family/requests/:id/approve`                 | POST   | Bearer (session) | Parent approves; server creates a time-limited `unblock_specific` rule on the device |
| `/api/v1/family/requests/:id/deny`                    | POST   | Bearer (session) | Parent denies; kid receives the verdict via WS + on next poll                      |
| `/api/v1/device/requests/:id`                         | GET    | Bearer (device)  | Kid polls the verdict (`pending` / `approved` / `denied` / `expired`)              |

**Auth model:**
- **Session tokens** (parent): HS256 JWT, `kind` is unset (only `sub` = accountId). 30-day TTL. Issued by signup / login / refresh / reset-confirm.
- **Device tokens** (child): HS256 JWT, `kind: "device"`, `sub` = accountId, `did` = deviceId. 1-year TTL. Issued by pair/redeem. Revocation = `DELETE /devices/:id` (drops the device row; subsequent auth check sees no row and fails).
- **Reset tokens**: HS256 JWT, `kind: "reset"`, 1-hour TTL. Rejected by both `requireAuth` (parent) and `requireDeviceAuth` (child) — only valid as the body parameter of `/auth/reset-confirm`.

**Password hashing:** PBKDF2-SHA256, 600 000 iterations, 16-byte random salt — NIST SP 800-132 (2023). All via WebCrypto.

---

## WebSocket protocol

Connect: `wss://<worker-host>/api/v1/device/ws` with `Authorization: Bearer <device-token>` header.

**Server → client messages:**

```jsonc
// New or updated rule
{ "type": "rule_change", "rule": { "id": "...", "kind": "block_now", "targetApps": [...], ... } }

// Rule deleted (parent removed it)
{ "type": "rule_delete", "ruleId": "..." }

// Device was unpaired by parent — daemon should close the WS and stop enforcing cloud rules
{ "type": "unpair" }

// Heartbeat acknowledgment
{ "type": "ack", "t": 1716295000000 }
```

**Client → server messages:**

```jsonc
// Heartbeat (recommend every 60s). Updates last_seen_at (throttled to 1 DB write per minute).
{ "type": "heartbeat" }
```

**Connection lifecycle:**
- One active WS per device. Re-connecting boots the previous WS (so a kid running two daemons can't keep an old, less-restricted state alive).
- If WS drops, child daemon should reconnect with exponential backoff and re-pull rules via `GET /api/v1/device/rules`.
- If no heartbeat is seen for 90 seconds, the device is shown as **offline** in the parent dashboard.

---

## Local development

### One-time setup

```bash
cd family-server
npm install

# Create the D1 database (run once per environment)
npm run db:create
# Paste the printed database_id into wrangler.toml under [[d1_databases]].

# Apply migrations to your local D1 (creates the SQLite file under .wrangler/)
npm run db:migrate:local

# Local JWT secret
cp .dev.vars.example .dev.vars
# Edit .dev.vars and replace JWT_SECRET with `openssl rand -hex 32` output.
```

### Run

```bash
npm run dev
# Worker on http://localhost:8787
```

---

## End-to-end curl walkthrough (pair + block)

```bash
BASE=http://localhost:8787

# ── Parent side ────────────────────────────────────────────────────────────

# 1. Parent signs up
curl -sX POST $BASE/api/v1/auth/signup \
  -H 'content-type: application/json' \
  -d '{"email":"alice@example.com","password":"correct horse battery"}'
# => { token, accountId, expiresIn }

PARENT_TOKEN=...   # paste the token

# 2. Parent generates a pairing code
curl -sX POST $BASE/api/v1/family/pair/create \
  -H "authorization: Bearer $PARENT_TOKEN"
# => { code: "123456", expiresAt: "...", ttlSeconds: 600 }

CODE=123456   # paste

# ── Child side ─────────────────────────────────────────────────────────────

# 3. Child daemon redeems the code (no parent auth — the code IS the proof)
curl -sX POST $BASE/api/v1/family/pair/redeem \
  -H 'content-type: application/json' \
  -d "{\"code\":\"$CODE\",\"hostname\":\"sams-laptop\",\"os\":\"windows\",\"osVersion\":\"11\"}"
# => { deviceId, deviceToken, accountId, expiresInSeconds }

DEVICE_ID=...
DEVICE_TOKEN=...

# 4. Child daemon connects WebSocket (use wscat or similar)
wscat -c "$BASE/api/v1/device/ws" -H "authorization: Bearer $DEVICE_TOKEN"
# Send: {"type":"heartbeat"}
# Expect: {"type":"ack","t":...}

# ── Parent side (with child connected) ─────────────────────────────────────

# 5. Parent sees the device online
curl -s $BASE/api/v1/family/devices \
  -H "authorization: Bearer $PARENT_TOKEN"
# => { devices: [{ id, hostname, os, pairedAt, lastSeenAt, online: true }] }

# 6. Parent creates a block_now rule on Sam's laptop
curl -sX POST "$BASE/api/v1/family/devices/$DEVICE_ID/rules" \
  -H "authorization: Bearer $PARENT_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"kind":"block_now","targetApps":["discord.exe","steam.exe"],"targetDomains":["reddit.com","x.com"]}'
# => { rule: { id, kind, targetApps, targetDomains, active: true, ... } }
# Child's wscat connection receives:
#   { "type": "rule_change", "rule": { ... } }
```

---

## Production deployment

```bash
# 1. Apply migrations to remote D1
npm run db:migrate:remote

# 2. Set JWT_SECRET as a Worker secret (paste a random 32-byte hex string)
npm run secret:set-jwt
# (paste `openssl rand -hex 32` output when prompted)

# 3. Deploy
npm run deploy
```

The deployed Worker URL goes into the parent-device FocusLock UI config (Phase 2.2 UI — separate, not yet built).

---

## Schema

See [`migrations/0001_initial_schema.sql`](./migrations/0001_initial_schema.sql).

Tables:
- **accounts** — parent accounts (id, email, password hash, timestamps)
- **devices** — paired child devices (id, account_id, hostname, os, token hash, last_seen)
- **pairing_codes** — short-lived 6-digit codes
- **lock_rules** — per-device rules (`block_now` / `schedule` / `unblock_all`); soft-deleted via `active = 0`
- **audit_log** — every parent + device event

---

## What's intentionally not here yet

- **Parent dashboard UI** — Phase 2.2 UI (React tab in FocusLock app); separate session
- **Child daemon integration** — Phase 2.3 (Windows C# + macOS Swift WS clients)
- **Anti-bypass hardening** — Phase 2.4 (monotonic clocks, Safe-Mode registration, admin-protected uninstall, non-admin-account auto-setup)
- **Email service integration** — currently `console.log` only
- **Rate limiting** — Cloudflare WAF covers us during beta; per-IP/per-account limits before public launch
- **TOTP 2FA** — Phase 3+
