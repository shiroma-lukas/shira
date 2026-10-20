# Agent Team Platform

Control plane for delegating software work to a managed team of AI agents. Humans discuss,
decide, and review; agents do the work and open pull requests. See the [PRD](docs/prd.md).

**Status:** M1 in progress. Tasks can be queued, inspected, and cancelled from the CLI; no
agent runs them yet. Next: the dispatcher, sandbox, and Claude Code adapter.

## Layout

| Path | What |
|---|---|
| `docs/prd.md` | Product requirements, v0.2 |
| `docs/contracts.md` | How agents hand off work and how paused tasks resume |
| `src/contracts/` | Wire contracts (Zod): envelope, reply, statuses, adapter interface, agent and repo config, permissions |
| `src/config/` | Loads and validates `config/` (`pnpm validate-config`) |
| `src/db/` | Postgres client wrappers and migration runner |
| `src/queue/` | Task store (queue, leases, retries, audit events), routing rules, intake, platform settings |
| `src/ledger/` | Cost ledger and budget checks |
| `src/cli/` | The `atp` CLI |
| `migrations/` | Postgres schema |
| `config/` | Agent definitions and per-repo onboarding configs |
| `context-template/` | Seed for the separate context repo |
| `examples/handoff/` | Example messages used by the docs and tests |
| `schemas/` | JSON Schemas generated from the contracts (`pnpm schemas`) |

## Development

```sh
pnpm install
pnpm typecheck
pnpm test             # migrations run against in-process Postgres (PGlite)
pnpm validate-config
pnpm schemas          # regenerate schemas/ after changing a contract
```

Running the CLI against a local database (port 54329, to avoid clashing with a local Postgres):

```sh
docker compose up -d --wait
pnpm atp migrate
pnpm atp submit --repo example-org/example-repo --goal "Fix CSV export dropping non-ASCII names"
pnpm atp list
pnpm atp show <task-id>
pnpm atp kill on          # pause all agents; `kill off` resumes
```

The concurrent-claim test needs a real Postgres and drops the schema of the database it is
given, so use a throwaway database:

```sh
docker compose exec postgres psql -U atp -c "CREATE DATABASE atp_test"
ATP_TEST_DATABASE_URL=postgres://atp:atp@localhost:54329/atp_test pnpm test
```
