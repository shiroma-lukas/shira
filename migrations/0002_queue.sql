-- Retry accounting and platform-wide settings (M1).

-- attempts counts every claim, including resumes after a decision. retries_used counts
-- only failed attempts (lost lease, crash, harness error) and is checked against the
-- task's budget.retries (FR-O4).
ALTER TABLE tasks ADD COLUMN retries_used integer NOT NULL DEFAULT 0;

CREATE TABLE platform_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Kill switch (FR-S4): while true, no task is claimed.
INSERT INTO platform_settings (key, value, updated_by) VALUES ('agents_paused', 'false', 'migration');

-- Monthly org spend ceiling in USD (FR-K2). null means not set; the dispatcher refuses
-- to start runs once the month's ledger total reaches it.
INSERT INTO platform_settings (key, value, updated_by) VALUES ('monthly_budget_usd', 'null', 'migration');
