-- Core schema: queue, audit log, ledger, locks, checkpoints (PRD section 11).
-- Status values mirror src/contracts/status.ts. Transitions are enforced in code (FR-S3).

CREATE TABLE repos (
  repo        text PRIMARY KEY,                -- org/name
  config_ref  text NOT NULL,                   -- path of the onboarding config (FR-A4)
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identities (
  id              text PRIMARY KEY,
  display_name    text NOT NULL,
  chat_id         text UNIQUE,                 -- e.g. Slack user id
  github_login    text UNIQUE,
  approval_roles  text[] NOT NULL DEFAULT '{}', -- matched against the approval matrix (FR-H2)
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE decisions (
  id           text PRIMARY KEY CHECK (id ~ '^D-[0-9]{4,}$'),
  record_ref   text NOT NULL,                  -- path of the decision record in the context repo
  approver_id  text NOT NULL REFERENCES identities(id),
  approved_at  timestamptz NOT NULL DEFAULT now(),
  thread_ref   jsonb
);

CREATE TABLE tasks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id        uuid REFERENCES tasks(id),
  requester        text NOT NULL,
  repo             text NOT NULL REFERENCES repos(repo),
  goal             text NOT NULL,
  role             text NOT NULL CHECK (role IN ('concierge','orchestrator','architect','planner','worker','reviewer','librarian')),
  status           text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','running','needs_decision','paused','blocked','done','failed','cancelled')),
  priority         integer NOT NULL DEFAULT 0,
  budget           jsonb NOT NULL,             -- Budget contract
  scope            jsonb NOT NULL,             -- Scope contract
  context_refs     jsonb NOT NULL DEFAULT '[]', -- Ref[]
  thread_ref       jsonb,
  decision_id      text REFERENCES decisions(id),
  attempts         integer NOT NULL DEFAULT 0,
  -- Dispatch lease: a worker claims a queued task with FOR UPDATE SKIP LOCKED and
  -- must renew before expiry, or the task is requeued.
  lease_owner      text,
  lease_expires_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tasks_dispatch_idx ON tasks (priority DESC, created_at) WHERE status = 'queued';
CREATE INDEX tasks_lease_idx ON tasks (lease_expires_at) WHERE status = 'running';
CREATE INDEX tasks_parent_idx ON tasks (parent_id);

-- blocked_by relationships (FR-Q3).
CREATE TABLE task_dependencies (
  task_id        uuid NOT NULL REFERENCES tasks(id),
  blocked_by_id  uuid NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, blocked_by_id),
  CHECK (task_id <> blocked_by_id)
);

-- Append-only audit log (FR-L1).
CREATE TABLE task_events (
  id           bigserial PRIMARY KEY,
  task_id      uuid NOT NULL REFERENCES tasks(id),
  at           timestamptz NOT NULL DEFAULT now(),
  kind         text NOT NULL CHECK (kind IN ('state_change','message','routing','approval','tool_action','note')),
  actor        text NOT NULL,                  -- role, identity id, or 'platform'
  from_status  text,
  to_status    text,
  payload      jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX task_events_task_idx ON task_events (task_id, id);

CREATE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER task_events_append_only
  BEFORE UPDATE OR DELETE ON task_events
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- Advisory path locks (FR-O6).
CREATE TABLE locks (
  id           bigserial PRIMARY KEY,
  task_id      uuid NOT NULL REFERENCES tasks(id),
  repo         text NOT NULL REFERENCES repos(repo),
  path_glob    text NOT NULL,
  mode         text NOT NULL CHECK (mode IN ('read','write')),
  acquired_at  timestamptz NOT NULL DEFAULT now(),
  released_at  timestamptz
);

CREATE INDEX locks_active_idx ON locks (repo) WHERE released_at IS NULL;

-- Cost ledger: one row per harness run (FR-K1).
CREATE TABLE runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id             uuid NOT NULL REFERENCES tasks(id),
  attempt             integer NOT NULL,
  role                text NOT NULL,
  harness             text NOT NULL,
  model               text NOT NULL,
  input_tokens        bigint NOT NULL DEFAULT 0,
  output_tokens       bigint NOT NULL DEFAULT 0,
  cache_read_tokens   bigint NOT NULL DEFAULT 0,
  cache_write_tokens  bigint NOT NULL DEFAULT 0,
  usd                 numeric(12,6) NOT NULL DEFAULT 0,
  started_at          timestamptz NOT NULL DEFAULT now(),
  ended_at            timestamptz,
  duration_ms         bigint,
  -- NULL while running; reply statuses or the RunOutcome abort reasons afterwards.
  outcome             text CHECK (outcome IN ('done','blocked','needs_decision','failed','cancelled','timeout','budget_exceeded','error')),
  transcript_uri      text,
  UNIQUE (task_id, attempt)
);

CREATE INDEX runs_task_idx ON runs (task_id);

-- Saved state for resuming paused tasks in a fresh sandbox (FR-E6).
CREATE TABLE checkpoints (
  id              bigserial PRIMARY KEY,
  task_id         uuid NOT NULL REFERENCES tasks(id),
  run_id          uuid NOT NULL REFERENCES runs(id),
  harness         text NOT NULL,
  branch          text NOT NULL,
  head_sha        text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  transcript_uri  text NOT NULL,
  session_ref     text,                        -- NULL: resume by replay
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX checkpoints_latest_idx ON checkpoints (task_id, id DESC);
