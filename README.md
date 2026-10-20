# Agent Team Platform

Control plane for delegating software work to a managed team of AI agents. Humans discuss,
decide, and review; agents do the work and open pull requests. See the [PRD](docs/prd.md).

**Status:** M0 (contracts). Nothing runs yet. The contracts, config schemas, and database
schema are in place for M1 (the one-task loop).

## Layout

| Path | What |
|---|---|
| `docs/prd.md` | Product requirements, v0.2 |
| `docs/contracts.md` | How agents hand off work and how paused tasks resume |
| `src/contracts/` | Wire contracts (Zod): envelope, reply, statuses, adapter interface, agent and repo config, permissions |
| `src/config/` | Loads and validates `config/` (`pnpm validate-config`) |
| `src/db/` | Migration runner |
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
