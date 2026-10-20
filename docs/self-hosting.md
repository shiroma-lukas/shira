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

export SHIRA_GITHUB_APP_ID=123456
export SHIRA_GITHUB_PRIVATE_KEY_PATH=~/keys/shira.pem
export ANTHROPIC_API_KEY=...
pnpm shira dispatch
```

Then submit work from another terminal with `pnpm shira submit --repo org/repo --goal "..."`.

## Settings

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://shira:shira@localhost:54329/shira` | Postgres |
| `SHIRA_CONFIG` | `./config` | Agent and repo definitions |
| `SHIRA_CONTEXT_DIR` | `./context-template` | Context repo checkout (role instructions) |
| `SHIRA_TRANSCRIPTS_DIR` | `./.shira/transcripts` | Redacted run transcripts |
| `SHIRA_SANDBOX_RUNTIME` | `runsc` | Container runtime; anything else needs `--unsafe-runtime` |
| `SHIRA_SANDBOX_NETWORK` | `shira-sandbox` | Internal network for sandboxes |
| `SHIRA_EGRESS_PROXY_URL` | `http://shira-egress:3128` | Proxy address as seen from sandboxes |
| `SHIRA_EGRESS_ADMIN_URL` | `http://127.0.0.1:8080` | Proxy admin API, from the dispatcher |
| `SHIRA_EGRESS_ADMIN_TOKEN` | (required) | Shared secret for the admin API |

## Repo images

A repo's `image` must contain git, coreutils (`timeout`), util-linux (`setsid`), procps (`kill`), and
the harness. Start from `images/worker/Dockerfile` and add the repo's toolchain.
