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
