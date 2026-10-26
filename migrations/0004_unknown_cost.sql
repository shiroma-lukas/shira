-- A run's cost can be unknown (a provider without a price for the model, or a run whose
-- dispatcher died before recording it). Unknown is recorded as NULL, never as zero, so
-- spend totals can say they are incomplete (FR-K1). No default: a run starts unknown
-- until finishRun records its cost.
ALTER TABLE runs ALTER COLUMN usd DROP NOT NULL;
ALTER TABLE runs ALTER COLUMN usd DROP DEFAULT;
