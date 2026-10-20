-- One-time rollout work: backfill completed history before deploying cleanup.
-- Do not apply to production until migration cost has been reviewed separately.
ALTER TABLE runs ADD COLUMN cleanup_pending INTEGER NOT NULL DEFAULT 1
  CHECK (cleanup_pending IN (0, 1));

UPDATE runs SET cleanup_pending = 0 WHERE id IN (SELECT run_id FROM results);

-- A completed run leaves the pending-only index in the same transaction as its
-- contribution and XP credit. The original credit_result trigger is unchanged.
CREATE TRIGGER mark_completed_run AFTER INSERT ON results BEGIN
  UPDATE runs SET cleanup_pending = 0 WHERE id = NEW.run_id;
END;

CREATE INDEX runs_cleanup_pending_expiry ON runs(expires_at, id)
  WHERE cleanup_pending = 1;
