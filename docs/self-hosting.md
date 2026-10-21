# Self-hosting on one machine

Shira's open-source core runs on a single Linux host: Postgres and the egress proxy in
Docker Compose, the dispatcher as a process, and each task in its own gVisor container.
For the managed, multi-machine version, see Shira Cloud.

## How a task is isolated

| Layer | What it does |
|---|---|
| gVisor (`runsc`) | Each sandbox gets its own user-space kernel, so code the agent runs never talks to the host kernel directly |
| Container limits | All capabilities dropped, `no-new-privileges`, CPU, memory, and process limits from the repo config |
| Internal network | Sandboxes sit on `shira-sandbox`, which has no route to the internet or the host |
| Egress proxy | The only way out. HTTPS only, per-sandbox credentials and allowlist, never private or link-local addresses (so no cloud metadata endpoint) |
| Credentials | The agent gets the model API key and nothing else. Git tokens are used only by platform commands, before and after the agent runs |

Default allowlist: `api.anthropic.com`, `github.com`, `*.githubusercontent.com`. Repos add
hosts with `egress.allow` in their config (e.g. `registry.npmjs.org`). Denials are logged
by the proxy as `egress_denied` events.

## Requirements

- Linux with Docker and [gVisor](https://gvisor.dev/docs/user_guide/install/) registered as
  the `runsc` runtime (`sudo runsc install && sudo systemctl restart docker`)
- Node 22 and pnpm
- A GitHub App ([setup](github-app.md)) and an Anthropic API key

On macOS there is no gVisor. You can develop with `SHIRA_SANDBOX_RUNTIME=runc
--unsafe-runtime`, which keeps every layer except the separate kernel.

## Run it

```sh
pnpm install
pnpm build:egress
docker build -f images/worker/Dockerfile -t shira-worker:latest .

export SHIRA_EGRESS_ADMIN_TOKEN=$(openssl rand -hex 24)
docker compose --profile sandbox up -d --build --wait
pnpm shira migrate

# Dispatchers connect as a least-privilege user, not the admin (see "Database roles")
export SHIRA_APP_DB_PASSWORD=$(openssl rand -hex 24)
pnpm shira app-user
export DATABASE_URL=postgres://shira_dispatcher:$SHIRA_APP_DB_PASSWORD@localhost:54329/shira

export SHIRA_GITHUB_APP_ID=123456
export SHIRA_GITHUB_PRIVATE_KEY_PATH=~/keys/shira.pem
export ANTHROPIC_API_KEY=...
pnpm shira dispatch
```

Then submit work from another terminal with `pnpm shira submit --repo org/repo --goal "..."`.

## Settings

Set these in the environment or in `.env` at the repo root (see `.env.example`); the
environment wins. Docker Compose reads the same file.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://shira:shira@localhost:54329/shira` | Postgres, as the app user (`shira app-user`) |
| `SHIRA_ADMIN_DATABASE_URL` | `DATABASE_URL` | Admin connection for `migrate` and `app-user` only |
| `SHIRA_CONFIG` | `./config` | Agent and repo definitions |
| `SHIRA_CONTEXT_DIR` | `./context-template` | Context repo checkout (role instructions) |
| `SHIRA_TRANSCRIPTS_DIR` | `./.shira/transcripts` | Redacted run transcripts on local disk |
| `SHIRA_TRANSCRIPTS_URI` | (unset) | `s3://bucket[/prefix]` stores transcripts in S3 instead (AWS credentials and region from the environment) |
| `SHIRA_SANDBOX_RUNTIME` | `runsc` | Container runtime; anything else needs `--unsafe-runtime` |
| `SHIRA_SANDBOX_NETWORK` | `shira-sandbox` | Internal network for sandboxes |
| `SHIRA_EGRESS_PROXY_URL` | `http://shira-egress:3128` | Proxy address as seen from sandboxes |
| `SHIRA_EGRESS_ADMIN_URL` | `http://127.0.0.1:8080` | Proxy admin API, from the dispatcher |
| `SHIRA_EGRESS_ADMIN_TOKEN` | (required) | Shared secret for the admin API |

## Database roles

The user that runs migrations owns the schema. Dispatchers and the CLI should connect as
a login user in the `shira_app` role instead, which migration `0005` creates with only the
privileges the code uses:

- no `DELETE` on any table, and no schema changes (`ALTER`, `DROP`, `CREATE`)
- inserts only on the audit log (`task_events`), checkpoints, and task dependencies; the
  audit log's append-only trigger can't be dropped either
- reads everywhere except `schema_migrations`; updates only on `tasks`, `runs`, and
  `platform_settings`; disabling a repo stays an admin action

`shira app-user [name]` (default `shira_dispatcher`) creates that login user, or resets its
password if it exists. It reads the password from `SHIRA_APP_DB_PASSWORD` and sends Postgres
only a SCRAM-SHA-256 verifier, so the plain password never reaches the server or its logs.
Run it, like `migrate`, with the admin connection (`SHIRA_ADMIN_DATABASE_URL`, or
`DATABASE_URL` when that is unset).

`shira dispatch` warns at startup when it is connected as a superuser, the schema owner, or
a user outside `shira_app`. The compose defaults use the `shira` superuser for convenience
during development.

## Repo images

A repo's `image` must contain git, coreutils (`timeout`), util-linux (`setsid`), procps (`kill`), and
the harness. Start from `images/worker/Dockerfile` and add the repo's toolchain.
