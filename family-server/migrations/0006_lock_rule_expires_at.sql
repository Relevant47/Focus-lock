-- Phase 3.2 — time-limited rules (unblock_specific kind) need a per-row
-- expiry timestamp. NULL for everything else (legacy + block_now + schedule
-- + unblock_all all stay permanent until manually removed).

ALTER TABLE lock_rules ADD COLUMN expires_at TEXT;
