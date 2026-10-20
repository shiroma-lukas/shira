# Shira

Control plane for delegating software work to a managed team of AI agents. Humans discuss,
decide, and review; agents do the work and open pull requests. See the [PRD](docs/prd.md).

**Status:** M1 in progress. The dispatcher runs the full loop (claim, sandbox, harness,
checkpoint and resume, rebase and test gate, secret scan, PR) and is tested end to end against
a scripted harness and a local, unisolated sandbox. The Claude Code adapter runs headless
(`claude -p --bare`) with redacted transcripts. Still missing for M1: an isolated sandbox
runtime and the GitHub App code host.

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
| `src/dispatcher/` | Claim-to-PR loop and the standard PR description |
| `src/harness/` | Claude Code adapter and transcript storage |
| `src/sandbox/` | Sandbox interface and a local dev-only provider (no isolation) |
| `src/security/` | Secret scanning for diffs and redaction |
| `src/cli/` | The `shira` CLI |
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
pnpm shira migrate
pnpm shira submit --repo example-org/example-repo --goal "Fix CSV export dropping non-ASCII names"
pnpm shira list
pnpm shira show <task-id>
pnpm shira kill on          # pause all agents; `kill off` resumes
```

The concurrent-claim test needs a real Postgres and drops the schema of the database it is
given, so use a throwaway database:

```sh
docker compose exec postgres psql -U shira -c "CREATE DATABASE shira_test"
SHIRA_TEST_DATABASE_URL=postgres://shira:shira@localhost:54329/shira_test pnpm test
```
