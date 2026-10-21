-- Dispatchers mirror the context repo's identities.yaml into identities (M2, FR-H2), which
-- decision records reference. Upserts only: rows are never deleted, so past decisions keep
-- their approver. Authority comes from the files, not from this table.
GRANT INSERT, UPDATE ON identities TO shira_app;
