-- Phase 2.9 — per-email rate limiting on auth endpoints.
--
-- One row per (action, email) key. Key shape: "login:<email>" / "reset:<email>".
-- The same key is used whether the email exists or not — otherwise a 429 on
-- only-real-emails would leak account existence.

CREATE TABLE auth_rate_limits (
  key            TEXT PRIMARY KEY,
  attempts       INTEGER NOT NULL DEFAULT 0,
  window_start   TEXT    NOT NULL,    -- ISO-8601 UTC of first attempt in current window
  blocked_until  TEXT                  -- ISO-8601 UTC; NULL when not currently blocked
);

CREATE INDEX idx_rate_limits_blocked ON auth_rate_limits(blocked_until)
  WHERE blocked_until IS NOT NULL;
