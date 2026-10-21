-- A run's cost can be unknown (a provider without a price for the model). Unknown is
-- recorded as NULL, never as zero, so spend totals can say they are incomplete (FR-K1).
ALTER TABLE runs ALTER COLUMN usd DROP NOT NULL;
