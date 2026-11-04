-- Decision records (M2, FR-C2). The row is the record of an approval as it happened; the
-- Markdown copy goes to the context repo through a PR (FR-C4). meta holds what the approval
-- covered (repo, risk, estimated cost), links, and the context PR once opened.
ALTER TABLE decisions ADD COLUMN title text;
ALTER TABLE decisions ADD COLUMN body text;
ALTER TABLE decisions ADD COLUMN meta jsonb NOT NULL DEFAULT '{}';
GRANT INSERT, UPDATE ON decisions TO shira_app;
