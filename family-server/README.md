# FocusLock — Family Controls Server

Cloudflare Worker + D1 backend for cross-device family controls (a parent on one device hard-locks apps on a child's device). **Phase 2.1 — auth slice only.** Pairing, devices, lock rules, and the WebSocket transport land in Phase 2.2+.

See [`docs/family-controls-design.md`](../docs/family-controls-design.md) for the full architecture and design decisions.

---

## What's in here (Phase 2.1)

| Route                              | Method | Auth          | What it does                                       |
|------------------------------------|--------|---------------|----------------------------------------------------|
| `/healthz`                         | GET    | none          | Liveness ping                                      |
| `/api/v1/auth/signup`              | POST   | none          | Create a parent account, return a session token    |
| `/api/v1/auth/login`               | POST   | none          | Verify email+password, return a session token      |
| `/api/v1/auth/refresh`             | POST   | Bearer (session) | Issue a fresh 30-day session token              |
| `/api/v1/auth/reset-request`       | POST   | none          | Email a reset token (currently logged to console)  |
| `/api/v1/auth/reset-confirm`       | POST   | none (reset tok in body) | Use a reset token to set a new password |

**Auth model:** session tokens are HS256 JWTs (30-day TTL) signed by the Worker's `JWT_SECRET`. Reset tokens are short-lived JWTs (1-hour TTL) with `kind: "reset"` claim; they cannot be used as session tokens.

**Password hashing:** PBKDF2-SHA256, 600 000 iterations, 16-byte random salt — NIST SP 800-132 (2023). All via WebCrypto, no native deps.

**Password recovery:** email reset, **instant** (no 24h delay). Trade-off accepted per [design doc decision #4](../docs/family-controls-design.md#product-decisions-locked-2026-05-21).

**Email enumeration resistance:** signup returns `409` on duplicate (which does leak — see below), but `/reset-request` always returns the same response regardless of whether the email is registered. **Open issue:** signup currently leaks account existence; revisit when adding email verification.

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

### Curl walkthrough

```bash
BASE=http://localhost:8787

# 1. signup
curl -sX POST $BASE/api/v1/auth/signup \
  -H 'content-type: application/json' \
  -d '{"email":"alice@example.com","password":"correct horse battery"}'
# => { "token": "eyJ...", "accountId": "uuid", "expiresIn": 2592000 }

TOKEN=...   # paste the token from above

# 2. login (separate device)
curl -sX POST $BASE/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"alice@example.com","password":"correct horse battery"}'

# 3. refresh
curl -sX POST $BASE/api/v1/auth/refresh \
  -H "authorization: Bearer $TOKEN"

# 4. password-reset request (check wrangler dev logs for the emitted token)
curl -sX POST $BASE/api/v1/auth/reset-request \
  -H 'content-type: application/json' \
  -d '{"email":"alice@example.com"}'

# 5. password-reset confirm (using the token from the log)
RESET_TOKEN=...   # paste from wrangler dev log line: [reset-email] to=... token=...
curl -sX POST $BASE/api/v1/auth/reset-confirm \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$RESET_TOKEN\",\"newPassword\":\"new horse staple\"}"
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

The deployed Worker URL goes into the parent-device FocusLock UI config (Phase 2.2). The Cloudflare updater Worker is unaffected — that's a separate Worker.

---

## Schema

See [`migrations/0001_initial_schema.sql`](./migrations/0001_initial_schema.sql).

Tables (only `accounts` and `audit_log` are exercised in Phase 2.1; the rest are scaffolded for Phase 2.2+):

- **accounts** — parent accounts (id, email, password hash, created_at, email_verified_at)
- **devices** — paired child devices (id, account_id, hostname, os, token hash, last_seen)
- **pairing_codes** — short-lived 6-digit pairing codes
- **lock_rules** — per-device lock rules (block_now / schedule / unblock_all)
- **audit_log** — every parent + device event (login, pair, lock_set, tamper, etc.)

---

## What's intentionally not here yet

- **Pairing endpoints** (`/pair/create`, `/pair/redeem`) — Phase 2.2
- **Device endpoints** (`/devices`, `/devices/:id/rules`) — Phase 2.2
- **WebSocket via Durable Objects** — Phase 2.2
- **Email integration** (Resend / SendGrid / Postmark) — currently `console.log` only, fine for beta
- **Rate limiting** — Cloudflare's built-in WAF rules will cover us during beta; per-IP/per-account limits added before public launch
- **TOTP 2FA** — Phase 3+
