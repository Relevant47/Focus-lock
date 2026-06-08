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
