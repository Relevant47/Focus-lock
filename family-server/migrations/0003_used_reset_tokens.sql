-- Single-use enforcement for password-reset JWTs.
--
-- The reset JWT is stateless and lives for 1 hour. Without a "consumed"
-- marker the same link can be redeemed multiple times within that window,
-- so a leaked link is a 1-hour persistent credential. Per-token rows
-- keyed on the JWT `jti` claim let resetConfirm refuse the second use.
--
-- expires_at is unix-ms (matches the JWT `exp` claim scaled to ms), so a
-- periodic cleanup job can `DELETE WHERE expires_at < <now>` cheaply.

CREATE TABLE used_reset_tokens (
  jti          TEXT PRIMARY KEY,    -- JWT jti claim (UUID v4)
  consumed_at  TEXT NOT NULL,       -- ISO-8601 UTC of consumption
  expires_at   INTEGER NOT NULL     -- unix-ms; for cleanup pruning
);

CREATE INDEX idx_used_reset_tokens_expires ON used_reset_tokens(expires_at);
