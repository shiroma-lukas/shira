# Contracts

How agents hand off work, and how a paused task resumes, explained from the contracts alone.
This is the M0 exit criterion in the [PRD](prd.md#13-milestones).

All wire contracts are Zod schemas in [`src/contracts/`](../src/contracts/). The JSON
examples below are the files in [`examples/handoff/`](../examples/handoff/), and
`test/contracts.test.ts` checks that they parse and link together correctly.

## The pieces

| Contract | File | Purpose |
|---|---|---|
| `Envelope` | `envelope.ts` | A unit of work from one role to another: goal, pointers, scope, completion criteria, budget |
| `Reply` | `envelope.ts` | The agent's answer: `done`, `blocked`, `needs_decision`, or `failed`, plus a summary of at most three lines |
| `Question` / `Answer` | `envelope.ts` | A decision the agent needs, and the human's answer to it |
| `Checkpoint` | `adapter.ts` | Saved branch, transcript, and harness session that let a task resume in a fresh sandbox |
| `HarnessAdapter` | `adapter.ts` | `start`, `send`, `resume`, `cancel`, `result`: the boundary to Claude Code and other harnesses |
| `TaskStatus` + transitions | `status.ts` | The task lifecycle and the only state changes the platform allows |
| `AgentDefinition`, `RepoConfig` | `agent.ts`, `repo.ts` | YAML config for roles and repos, validated in CI |
| Permission ceiling | `permissions.ts` | The most each role can ever be granted. Config can narrow it, never widen it |

Rules shared by every message:

- **Pointers, not content.** `refs` hold typed pointers (`file`, `context`, `decision`, `pr`, `thread`, ...). Text fields have short length limits, so pasting a file into a goal fails validation.
- **Versioned.** Every message carries `v: 1`. A breaking change bumps `CONTRACT_VERSION`.
- **Policy in code.** Transitions, permission ceilings, and the reply rules (a `needs_decision` must carry a question, a `done` must carry an artifact) are enforced by the schemas, not by prompts.

## Walkthrough: a bug fix with one decision

### 1. The orchestrator hands the task to a worker

The task is `queued`. The dispatcher claims it (`queued → running`), creates a sandbox with a
fresh branch, and starts the worker through `adapter.start({ envelope, workspace, model, instructions })`.

```json
{
  "v": 1,
  "id": "0b8f1c2d-…",
  "task_id": "7c1e2a4b-…",
  "from": "orchestrator",
  "to": "worker",
  "goal": "Fix CSV export dropping rows whose customer name contains non-ASCII characters.",
  "refs": [
    { "kind": "thread", "provider": "cli", "id": "req-0142" },
    { "kind": "file", "repo": "example-org/example-repo", "path": "src/export/csv.ts" },
    { "kind": "context", "path": "conventions/testing.md" }
  ],
  "scope": { "repo": "example-org/example-repo", "paths": ["src/export/**", "test/export/**"] },
  "done_when": [
    "A regression test with a non-ASCII name fails before the fix and passes after",
    "pnpm test passes after rebasing on main",
    "PR opened against main"
  ],
  "budget": { "usd": 3, "tokens": 2000000, "minutes": 30, "retries": 2 }
}
```

The worker gets only the goal and pointers. It reads `csv.ts` and the testing convention when it needs them.

### 2. The worker hits a decision

`adapter.result(session)` resolves with `{ kind: "reply", reply, usage, transcriptUri, sessionRef }`.
The platform writes the `usage` to the `runs` ledger.

```json
{
  "status": "needs_decision",
  "in_reply_to": "0b8f1c2d-…",
  "summary": "Repro'd: rows dropped when names arrive NFD-encoded.\nRegression test committed on branch; fix depends on normalization choice.",
  "question": {
    "kind": "technical",
    "text": "Normalize names to NFC on export, or preserve input bytes and fix the row filter only?",
    "options": ["Normalize to NFC", "Preserve bytes, fix filter only"],
    "refs": [{ "kind": "file", "repo": "example-org/example-repo", "path": "src/export/csv.ts", "sha": "4f2a9c1" }]
  }
}
```

`question.kind` routes it: `technical` goes to the owning tech lead (to the architect agent
from M4), and `business` goes to the concierge, then a human.

### 3. The platform checkpoints and tears down

The task moves `running → needs_decision`. The worker already committed its work in progress,
so the platform records a checkpoint and destroys the sandbox. Nothing stays running while a
human thinks.

```json
{
  "task_id": "7c1e2a4b-…",
  "run_id": "5d6e7f8a-…",
  "harness": "claude-code",
  "repo": "example-org/example-repo",
  "branch": "atp/7c1e2a4b-csv-unicode",
  "head_sha": "4f2a9c1e8b7d6a5c4b3a2f1e0d9c8b7a6f5e4d3c",
  "transcript_uri": "s3://atp-transcripts/7c1e2a4b/5d6e7f8a.jsonl",
  "session_ref": "cc-session-01JB6Z8K",
  "created_at": "2026-10-19T14:02:11Z"
}
```

`session_ref` is the harness's own session id. If it is `null`, the adapter resumes by replaying
the transcript on top of the branch instead.

### 4. A human answers

The answer points at the question it resolves and records who answered. Here it was also
recorded as decision `D-0007` in the context repo.

```json
{
  "v": 1,
  "task_id": "7c1e2a4b-…",
  "in_reply_to": "3a4b5c6d-…",
  "answered_by": "tech-lead-1",
  "text": "Normalize to NFC; downstream systems compare names byte-wise.",
  "choice": 0,
  "decision_id": "D-0007"
}
```

The task moves `needs_decision → queued`. A resumed task goes back through the queue like any
other, so priorities, concurrency limits, and budgets still apply. It never jumps straight back
to `running`.

### 5. The worker resumes and finishes

The dispatcher claims the task again, builds a new sandbox on the checkpoint's branch at
`head_sha`, and calls `adapter.resume({ envelope, workspace, model, instructions, checkpoint, answer })`.
The original envelope is reused, so the goal, scope, and budget are unchanged. The budget
counts spending across both runs.

```json
{
  "status": "done",
  "in_reply_to": "0b8f1c2d-…",
  "summary": "Names normalized to NFC before row filter (per D-0007).\nRegression test added; full suite green after rebase.",
  "artifact": { "kind": "pr", "repo": "example-org/example-repo", "number": 418 }
}
```

The final reply answers the original envelope, not the answer. The task moves `running → done`.

### The status path

```
queued → running → needs_decision → queued → running → done
                   (checkpoint,      (answer
                    sandbox gone)     received)
```

Every step is written to `task_events`, which is append-only: a trigger rejects updates and
deletes. With the transcripts in `runs.transcript_uri`, this is enough to reconstruct why the
PR looks the way it does.

## Lifecycle rules

| From | Allowed next states |
|---|---|
| `queued` | `running`, `blocked`, `cancelled` |
| `running` | `done`, `failed`, `needs_decision`, `paused`, `blocked`, `queued` (retry or lost lease), `cancelled` |
| `needs_decision`, `paused`, `blocked` | `queued`, `cancelled` |
| `done`, `failed`, `cancelled` | none (terminal) |

## Database

[`migrations/0001_init.sql`](../migrations/0001_init.sql) creates `tasks`,
`task_dependencies`, `task_events`, `runs` (the ledger), `checkpoints`, `locks`, `decisions`,
`identities`, and `repos`. Workers claim tasks with `FOR UPDATE SKIP LOCKED` and hold a lease
(`lease_owner`, `lease_expires_at`). A task whose lease expires goes back to `queued`.
