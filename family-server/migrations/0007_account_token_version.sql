-- Phase 3.3 — per-account session invalidation. When a parent resets their
-- password (or explicitly logs everyone out), we need outstanding 30-day
-- session JWTs to stop being accepted. The JWT itself is stateless, so we
-- embed the account's current `token_version` as a `tv` claim at sign time
-- and require the middleware to compare it against the live column on every
-- authenticated request. Incrementing the column revokes every token issued
-- before the bump.
--
-- Pre-migration tokens have no `tv` claim; the middleware treats a missing
-- claim as 0, matching the DEFAULT 0 here — so already-issued sessions keep
-- working until an explicit reset bumps the column.

ALTER TABLE accounts ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
