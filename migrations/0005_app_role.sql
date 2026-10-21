-- Least-privilege role for dispatchers and the CLI. The migrating user owns the schema;
-- shira_app gets only what the code uses: no DELETE, no DDL, and inserts only on the
-- audit log, checkpoints, and dependency links. Login users join it (`shira app-user`).
-- A table or statement added later needs its grant here too, in its own migration.
-- Numbered 0005 so it never collides with 0004_unknown_cost (PR #18).

DO $$
BEGIN
  -- Roles are cluster-wide: another database in the cluster may have created it already.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shira_app') THEN
    CREATE ROLE shira_app NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO shira_app;

GRANT SELECT ON repos, identities, decisions, tasks, task_dependencies, task_events,
  locks, runs, checkpoints, platform_settings TO shira_app;

GRANT INSERT, UPDATE ON tasks, runs, platform_settings TO shira_app;
-- repos: intake registers onboarded repos (INSERT ... ON CONFLICT DO NOTHING).
GRANT INSERT ON repos, task_dependencies, task_events, checkpoints TO shira_app;

-- bigserial ids on the insert-only tables.
GRANT USAGE ON SEQUENCE task_events_id_seq, checkpoints_id_seq TO shira_app;
