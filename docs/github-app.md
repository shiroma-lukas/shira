# GitHub App setup

Shira reaches repositories only through a GitHub App you own. It never uses a personal token.

## How Shira uses it

Every credential is a one-hour installation token scoped to **one repository** and the
fewest permissions for the job:

| Token | Permissions | Used for | Who holds it |
|---|---|---|---|
| read | `contents: read` | Cloning the task repo, fetching the default branch | Platform git commands only |
| write | `contents: write` | Pushing the task branch, after the agent has exited | Platform git commands only |
| pull request | `pull_requests: write` | Opening the PR | The dispatcher process |

Tokens go to individual git commands through `GIT_CONFIG_*` environment variables. They
never appear in command lines, `.git/config`, or the agent's environment. The agent can
commit, but it has no credential that can push. Merging stays a human action: Shira never
asks for a token that could merge (PRD FR-S1).

## 1. Create the App

GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**
(or the same path under your organization's settings).

- **Name:** anything, e.g. `shira-yourorg`
- **Homepage URL:** your repo or site
- **Webhook:** uncheck **Active**. M1 doesn't need events; PR review comments arrive in M2.
- **Repository permissions:**
  - Contents: **Read and write**
  - Pull requests: **Read and write**
  - Metadata: **Read-only** (mandatory)
  - Everything else: No access
- **Where can this GitHub App be installed?** Only on this account

After creating it, note the **App ID**, then under **Private keys** click **Generate a
private key** and save the `.pem` file somewhere outside the repo.

## 2. Install it on the repos Shira may touch

App settings → **Install App** → choose the account → **Only select repositories**, then
pick the repos. Shira can only reach repos the App is installed on, and each task's tokens
are narrowed to that task's repo.

## 3. Onboard the repo and run

Add a repo config under `config/repos/` (see `config/repos/example.yaml`), then:

```sh
export SHIRA_GITHUB_APP_ID=123456
export SHIRA_GITHUB_PRIVATE_KEY_PATH=~/keys/shira-yourorg.pem
export ANTHROPIC_API_KEY=...           # workers run Claude Code in --bare mode

pnpm shira submit --repo yourorg/yourrepo --goal "Fix ..."
pnpm shira dispatch --unsafe-local-sandbox
```

`--unsafe-local-sandbox` runs the agent directly on your machine, without isolation. Use it
only with repos and requests you trust, until the gVisor sandbox lands.

## Rotating the key

Generate a new private key in the App settings, point `SHIRA_GITHUB_PRIVATE_KEY_PATH` at it,
restart dispatchers, then delete the old key in the App settings. Existing installation
tokens expire within an hour.
