-- Runs can end with config_error: a failure retrying can't fix (rejected credential,
-- missing permission). The task fails at once instead of using up its retries.
ALTER TABLE runs DROP CONSTRAINT runs_outcome_check;
ALTER TABLE runs ADD CONSTRAINT runs_outcome_check
  CHECK (outcome IN ('done','blocked','needs_decision','failed','cancelled','timeout','budget_exceeded','config_error','error'));
