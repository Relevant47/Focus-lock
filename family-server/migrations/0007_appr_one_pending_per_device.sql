-- v1.4.1 anti-spam invariant ("one pending per device at a time") was previously
-- enforced only in application code: a SELECT (findAnyPendingForDevice) followed
-- by a plain INSERT (createApprovalRequest), with no transaction and no DB-level
-- constraint between them. Two near-simultaneous requests from the same kid
-- device (flaky daemon retry, double-click before the UI disables the button)
-- could both pass the check and both INSERT, producing two pending rows on the
-- same device. Add a partial unique index so SQLite enforces the invariant at
-- write time; the handler catches the resulting UNIQUE constraint failure and
-- returns the existing pending row via a normal 409 pending_exists.
CREATE UNIQUE INDEX idx_appr_one_pending_per_device
  ON approval_requests(device_id)
  WHERE status = 'pending';
