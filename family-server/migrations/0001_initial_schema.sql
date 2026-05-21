-- Phase 2.1 initial schema for FocusLock family-controls cloud backend.

CREATE TABLE accounts (
  id                 TEXT PRIMARY KEY,        -- UUID v4
  email              TEXT UNIQUE NOT NULL,    -- always stored lowercase
  password_hash      TEXT NOT NULL,           -- pbkdf2$<iters>$<salt-hex>$<hash-hex>
  created_at         TEXT NOT NULL,           -- ISO-8601 UTC
  email_verified_at  TEXT
);

CREATE TABLE devices (
  id                 TEXT PRIMARY KEY,        -- UUID v4
  account_id         TEXT NOT NULL,
  hostname           TEXT,
  os                 TEXT NOT NULL,           -- 'windows' | 'macos'
  os_version         TEXT,
  paired_at          TEXT NOT NULL,
  last_seen_at       TEXT,
  last_ip            TEXT,
  device_token_hash  TEXT NOT NULL,           -- hash of the device bearer token
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE pairing_codes (
  code                    TEXT PRIMARY KEY,   -- 6-digit numeric, short-lived
  account_id              TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  expires_at              TEXT NOT NULL,
  consumed_at             TEXT,
  consumed_by_device_id   TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE lock_rules (
  id                     TEXT PRIMARY KEY,
  device_id              TEXT NOT NULL,
  kind                   TEXT NOT NULL,       -- 'block_now' | 'schedule' | 'unblock_all'
  target_apps            TEXT,                -- JSON array
  target_domains         TEXT,                -- JSON array
  schedule_cron          TEXT,                -- cron expr for 'schedule' kind
  active                 INTEGER NOT NULL DEFAULT 1,
  created_at             TEXT NOT NULL,
  created_by_account_id  TEXT NOT NULL,
  FOREIGN KEY (device_id)             REFERENCES devices(id)  ON DELETE CASCADE,
  FOREIGN KEY (created_by_account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  TEXT,                           -- nullable: events without a known account
  device_id   TEXT,
  event       TEXT NOT NULL,
  payload     TEXT,                           -- JSON
  ip          TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_devices_account         ON devices(account_id);
CREATE INDEX idx_lock_rules_device       ON lock_rules(device_id, active);
CREATE INDEX idx_audit_account_time      ON audit_log(account_id, created_at DESC);
CREATE INDEX idx_pairing_codes_expires   ON pairing_codes(expires_at);
