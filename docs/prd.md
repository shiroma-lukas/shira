# PRD: Agent Team Platform

Draft v0.2 | October 19, 2026 | Status: for review | Working name, to be replaced

## Changes from v0.1

- **Milestone tags replace P0/P1/P2.** Each requirement is tagged with the milestone it ships in (M0–M4, or Later). "Required for v1" now means M0–M2. This removes v0.1's contradictions (the planner, architect, router classifier, merge queue and reviewer agent were P0 or P1 while shipping in M3 or M4).
- **Interim behavior before M3/M4 roles exist.** Technical questions go to the human tech lead until the architect ships. Routing is rule-based until the classifier ships.
- **Path locks are advisory.** The merge queue and rebase-and-test gate are what protect main. Scope violations now have a defined response.
- **Pause and resume is specified.** Paused tasks checkpoint and tear down, then rehydrate on reply. `resume` is part of the adapter interface.
- **Security moved earlier and got more specific.** Untrusted-input handling ships with the first untrusted input (M2). Sandbox isolation is stronger than plain Docker. Egress goes through an allowlist proxy. Identity mapping and approval authority are defined.
- **New requirements:** per-repo onboarding config, an eval gate for agent configuration changes, transcript retention and redaction, and an org kill switch from M1.
- **Metrics are defined.** Cost per merged PR is paired with review time and rework rate. "Major rework" and "routing accuracy" have definitions and a ground truth.
- **Open questions show which milestone they block.**

## 1. Summary

Agent Team Platform lets a solo developer or a team delegate software work to a managed team of AI agents. People message the system in the channels they already use (chat, issue tracker, CLI). The platform turns those conversations into approved decisions, plans the work, runs coding agents in isolated sandboxes on VMs, and returns pull requests for human review. Humans discuss, decide, and review. Agents do the work.

Three ideas shape the product:

1. Centralized, versioned company context that every agent reads and that agents help maintain, with humans reviewing every change.
2. A role gradient of agents, from human-facing to code-facing, that communicate through concise, typed messages.
3. Cost, parallelism, and multi-model operation as first-class constraints, not afterthoughts.

## 2. Problem Statement

Teams experimenting with coding agents run into the same issues:

- Parallel agents collide: merge conflicts, duplicated work, and broken main branches.
- No centralized company context: each agent session starts blind or is hand-fed context, so results are inconsistent.
- Humans babysit sessions instead of making decisions and reviewing output.
- Costs are opaque and grow with retries, subagent fan-out, and large context loads.
- Lock-in: work is tied to one tool or provider, with no way to route by cost or capability.
- No reliable human loop: agents cannot ask a question, wait, resume, and notify the right person.

## 3. Goals and Non-Goals

### Goals

- **G1:** Change the human workflow so people only discuss ideas, make decisions, and review pull requests.
- **G2:** Run many agent tasks in parallel on shared repositories without breaking main or duplicating work.
- **G3:** Give every agent access to accurate, current company and project context.
- **G4:** Make cost visible, budgeted, and optimized, measured against output quality and human review time.
- **G5:** Support multiple models and agent harnesses behind stable contracts.
- **G6:** Let admins define the agent team declaratively, in version control.
- **G7:** Let agents open pull requests and message the right people at the right time.

### Non-Goals (v1)

- Building a new coding model or a new agent runtime. Existing harnesses are used.
- Replacing human code review.
- Autonomous merging or deployment.
- A general-purpose chat assistant, web IDE, or project-management tool.
- Multi-tenant SaaS. v1 serves a single organization.

## 4. Users and Personas

| Persona | Needs |
|---|---|
| Solo developer | Delegate chores and bugs, review PRs, minimal setup |
| Team engineer | Request fixes, propose ideas, review PRs, trust the output |
| Tech lead / architect | Approve architecture decisions, own conventions, review high-risk PRs, answer technical escalations (until the architect agent ships) |
| Product or non-engineering stakeholder | Request changes in plain language, answer questions, see status |
| Platform admin | Define agents, budgets, permissions, integrations, and approval authority |

## 5. Product Principles

1. Humans decide, agents execute.
2. Context is a product: versioned, reviewed, and kept fresh.
3. Distance gradient: the further an agent is from humans, the less business context and prose it carries, and the more code context and terseness.
4. Typed, concise, pointer-based messages between agents. Full transcripts are always kept, so terseness never costs auditability.
5. Cheap by default, expensive by exception.
6. Isolation before concurrency.
7. Everything auditable.
8. Swappable parts: models, harnesses, and tools sit behind stable contracts.
9. Main is protected by gates, not by predictions. Planning reduces conflicts; the merge queue and test gate prevent breakage.

## 6. Key User Flows

Each flow lists the milestone it first works end to end.

- **Flow A: Idea to PR (M2 single task, M3 multi-task).** A human discusses an idea in a chat thread. The concierge distills it into a proposal (scope, assumptions, risk, estimated cost). An authorized human approves. In M2 the approved proposal becomes one worker task; from M3 the planner splits it into a task graph. Workers produce PRs. From M3 a reviewer agent pre-checks them. Humans review and merge.
- **Flow B: Bug report to fix (M1 from CLI, M2 from chat).** A bug is reported. The router classifies it and picks a role. A worker reproduces, fixes, tests, and opens a PR. The reporter is notified.
- **Flow C: Agent needs a decision (M2).** A worker hits ambiguity and returns `needs_decision`. Business questions route to the concierge, then to the right human. Technical questions route to the owning tech lead (from M4, to the architect agent first). The task checkpoints and tears down its sandbox, then resumes when answered.
- **Flow D: Review feedback loop (M2, convention proposals M4).** A reviewer comments on a PR. The comment becomes a task for the originating worker, who updates the PR. From M4, recurring feedback is proposed as a convention update in the context repo.
- **Flow E: New project (M4).** A human describes a new project. The architect proposes structure and stack. After approval, the planner scaffolds tasks and workers create the initial repository contents through PRs.
- **Flow F: Admin defines the team (M1 basic, M3 with eval gate).** An admin edits agent definitions, model policy, budgets, and permissions in version control. CI validates them and, from M3, runs the eval suite. Changes take effect without a code deploy.

## 7. Agent Roster

| Role | Ships | Faces | Speaks | Model tier | Holds |
|---|---|---|---|---|---|
| Worker | M1 | Code | Terse | Mid or low | One repo and one task |
| Orchestrator | M1 (rules), M4 (classifier) | Internal | Typed messages | None, then small | Routing table, queue state, budgets |
| Concierge | M2 | Humans | Natural language | Mid | Company context, decision log, who is who |
| Planner | M3 | Internal | Typed | Mid | Task graph, file and module ownership hints |
| Reviewer | M3 | Code, then humans | Terse in, structured PR summary out | Mid, different family from author | Decision record and diff |
| Architect | M4 | Humans and code | Natural language out, specs in and out | Top | Architecture, conventions, decision records |
| Librarian | M4 | Context repo | Mixed | Low or mid | Freshness and contradictions |

**Before a role ships, its job falls back as follows:** planner work is done by the human approving the proposal, who scopes it as a single task. Architect escalations go to the owning tech lead. Reviewer pre-checks are limited to the CI and test gate. Librarian duties are manual.

## 8. Functional Requirements

Tags: **M0–M4** = the milestone a requirement ships in. **Later** = after M4. M0–M2 is the v1 core.

### 8.1 Intake and Queue

- **FR-Q1 (M1 CLI, M2 chat):** Accept work from a CLI and a chat tool (assumed Slack). Normalize each request into a task with id, requester, repo, goal, priority, thread reference, and context references.
- **FR-Q2 (M1):** Durable queue with states: `queued`, `running`, `needs_decision`, `paused`, `blocked`, `done`, `failed`, `cancelled`. Survives control-plane restarts with no lost tasks.
- **FR-Q3 (M0 schema, M3 used):** Tasks support parent/child and `blocked_by` relationships.
- **FR-Q4 (M2):** Cancel, pause, and re-prioritize from chat or CLI (CLI from M1).
- **FR-Q5 (M3):** Priorities, per-requester and per-project concurrency limits, fair scheduling.
- **FR-Q6 (M4):** Accept work from issue-tracker events and from PR comments that don't belong to an agent PR.

### 8.2 Context Layer

- **FR-C1 (M0 skeleton, M2 populated):** A versioned context repository holds the company overview, project specs and architecture, conventions and playbooks, ownership and contact preferences, glossary, and decision log.
- **FR-C2 (M2):** Every approved proposal produces a short decision record (what, why, approver, date, links). Tasks reference decisions by ID.
- **FR-C3 (M1):** Agents load context by pointer and on demand. Base prompts stay small.
- **FR-C4 (M2):** Context changes proposed by agents go through a pull request and human review.
- **FR-C5 (M4):** Each document has an owner and a freshness date, with staleness reports.
- **FR-C6 (M4):** Librarian agent extracts decisions from threads, flags stale or contradictory documents, and proposes updates after merged PRs.
- **FR-C7 (Later):** Ingestion from external knowledge sources such as a wiki or tracker.

### 8.3 Agent and Repository Definition

- **FR-A1 (M0 schema, M1 loaded):** Declarative agent definitions in version control: role, model policy, tools, permissions, budget, and instructions.
- **FR-A2 (M1):** Role-to-model and role-to-harness mapping lives in configuration with fallbacks. Changes need no code deploy.
- **FR-A3 (M1):** Definitions are validated in CI (schema check and permission lint).
- **FR-A4 (M0 schema, M1 used):** Per-repo onboarding config: container image or toolchain, setup command, test command, lint command, a quarantine list for known-flaky tests, and the number of retries allowed for a flaky test before it counts as a failure. A repo without this config cannot receive tasks.
- **FR-A5 (M3):** Eval gate. Changes to model policy, harness mapping, or instructions run against a fixed suite of known tasks before taking effect. Results go to the ledger, and a regression beyond an agreed threshold blocks the change.
- **FR-A6 (M4):** Reusable agent blueprints and team topologies.

### 8.4 Orchestration and Parallelism

- **FR-O1 (M1 rules, M4 classifier):** The router assigns each task to a role. Through M3 it uses hard rules only (for example, chat threads go to the concierge, approved tasks go to a worker). From M4 a classifier runs after the rules (a cheap LLM first; a specialized decision model such as Jev evaluated against it), with confidence-based escalation to a human. Every routing decision and outcome is logged from M1, so the M4 classifier has labeled data.
- **FR-O2 (M1):** One task equals one branch equals one isolated workspace.
- **FR-O3 (M1):** Before opening a PR, rebase on the latest main and run the repo's test command. A conflict triggers one automated resolution attempt, then escalation.
- **FR-O4 (M1):** Bounded retries with backoff per task, then escalation. No infinite loops.
- **FR-O5 (M3):** Planner decomposes approved specs into a task graph with dependencies and declared file and module scope before workers start.
- **FR-O6 (M3):** Advisory path-level locks. The scheduler uses declared scope to serialize tasks that overlap. Locks are hints, not guarantees.
- **FR-O7 (M3):** Declared scope is checked against the actual diff at PR time. If the diff goes outside scope and overlaps an in-flight task, the PR is held and the planner either serializes the tasks or asks a human. If it goes outside scope without overlap, the PR is opened and labeled as out of scope.
- **FR-O8 (M3):** Merge queue integration. Agent PRs merge only through a queue that re-tests against the latest main, so parallel PRs cannot break main. Humans still trigger the merge.
- **FR-O9 (M3):** Read-only in-flight view so agents can see what others are touching.

### 8.5 Execution Environment

- **FR-E1 (M1):** Each task runs in a sandbox on a VM with a fresh clone or worktree, the repo's toolchain, and the agent harness.
- **FR-E2 (M1):** Sandbox isolation stronger than a shared-kernel container (for example gVisor, Kata, or Firecracker), because agents run arbitrary repository code that may have been influenced by untrusted input.
- **FR-E3 (M1):** Scoped, short-lived credentials per task (for example GitHub App installation tokens limited to one repo). No production access.
- **FR-E4 (M1):** Egress only through an allowlist proxy. Package registries are reached through the proxy or a mirror. Everything else is denied by default and logged.
- **FR-E5 (M1):** Hard time and resource limits with automatic teardown.
- **FR-E6 (M2):** Checkpoint and rehydrate. When a task enters `needs_decision` or `paused`, the platform saves the branch, transcript, and harness session state, then tears the sandbox down. On reply it rebuilds the sandbox and resumes the session. No sandbox stays alive while waiting on a human.
- **FR-E7 (M3):** Warm pools and cached dependencies for fast starts.
- **FR-E8 (M4):** Horizontal scaling across multiple VMs.

### 8.6 Agent Communication

- **FR-M1 (M0):** Inter-agent messages use a versioned typed envelope: `task_id`, `from`, `to`, `goal`, `refs`, `scope`, `done_when`, `budget`.
- **FR-M2 (M0):** Replies use fixed statuses (`done`, `blocked`, `needs_decision`, `failed`) with an artifact link and a summary of at most three lines.
- **FR-M3 (M1):** Messages pass pointers (paths, record IDs), not pasted content.
- **FR-M4 (M1):** Natural language appears only at the human-facing edge. Internal messages are terse. Full harness transcripts are retained (FR-L2), so the reasoning can always be reconstructed.
- **FR-M5 (M2):** `needs_decision` routes upward automatically: business questions to the concierge, then a human; technical questions to the owning tech lead (to the architect agent first from M4).

### 8.7 Human Interaction

- **FR-H1 (M2):** Concierge turns discussion into a concrete proposal with assumptions, scope, risk, and estimated cost. An authorized human approves, edits, or rejects with one action.
- **FR-H2 (M2):** Identity and approval authority. Chat identities map to GitHub identities. An approval matrix in the context repo says who may approve which kinds of proposals (by repo, risk level, and estimated cost). Approvals from anyone else are recorded but not acted on.
- **FR-H3 (M2):** Agents can pause on a question and resume on reply (implemented by FR-E6).
- **FR-H4 (M1):** Standard PR description: change summary, linked decision (from M2), risk level, verification evidence, and cost.
- **FR-H5 (M2):** PR review comments on agent PRs are routed back to the originating worker as tasks.
- **FR-H6 (M2):** Agents notify the right person using ownership and contact preferences from the context repo. Non-urgent items are batched into digests.
- **FR-H7 (M3):** Reviewer agent pre-checks tests, conventions, and scope before human review.
- **FR-H8 (M4):** Risk-based reviewer routing and per-reviewer work-in-progress caps.
- **FR-H9 (M4):** Recurring review feedback is proposed as convention updates.

### 8.8 Cost Management

- **FR-K1 (M1):** Ledger entry per run: task, role, harness, model, input, output, and cached tokens, dollars, duration, and outcome.
- **FR-K2 (M1):** Per-task and per-role budgets (dollars, tokens, time, retries) with hard stops and escalation. A monthly org budget with a hard stop.
- **FR-K3 (M1 workers, M2 concierge and summaries, M4 architect):** Model tiering: small models for routing and summaries, mid-tier for workers, top tier only for the architect and hard cases.
- **FR-K4 (M1):** Prompts are structured for caching, with a stable prefix.
- **FR-K5 (M2):** Estimated cost shown in proposals before approval. After the task, estimated and actual cost are compared in the ledger.
- **FR-K6 (M3):** Token optimizers in worker sandboxes, such as shell-output compression (RTK) and terse-output skills (Caveman, internal messages only). Turned on per role, with their effect measured in the ledger against a control.
- **FR-K7 (M4):** Cost per merged PR reported by project, role, and model, alongside review time and rework rate (section 12), with a weekly digest.

### 8.9 Multi-Model and Harness Support

- **FR-X1 (M0 interface, M1 first adapter):** Harness adapter interface with `start`, `send`, `resume`, `cancel`, and `result` (including usage). `resume` restores a checkpointed session (FR-E6). An adapter that cannot resume natively replays from the saved transcript and branch.
- **FR-X2 (M3):** A second harness or model family supported.
- **FR-X3 (M3):** The reviewer agent uses a different model family from the author of the change (configurable).
- **FR-X4 (M3):** One canonical instruction file with per-harness shims.
- **FR-X5 (M4):** Gateway for keys, rate limits, fallback, and usage logging.

### 8.10 Observability and Audit

- **FR-L1 (M1):** Append-only event log for every task state change, message, routing decision, approval, and tool action.
- **FR-L2 (M1):** Full transcripts retained per run and linked from the PR and task.
- **FR-L3 (M1):** Transcript retention and redaction. A redaction pass runs before storage. The retention period is configurable (proposed default: 90 days). Ledger and event-log entries are kept indefinitely; transcripts are not.
- **FR-L4 (M3):** Alerts on budget breach, stuck tasks, and repeated failures.
- **FR-L5 (M4):** Dashboards or digests: queue depth, throughput, failure reasons, cost, review outcomes.

### 8.11 Security and Permissions

- **FR-S1 (M0 schema, M1 enforced):** Permission matrix per role (read, branch, open PR, comment, message). Merge and deploy are disabled in v1.
- **FR-S2 (M1):** Secrets never enter prompts or logs. Secret scanning on diffs before a PR is opened.
- **FR-S3 (M1):** Policy, budgets, and approvals are enforced in code, not by prompting.
- **FR-S4 (M1):** Organization-level kill switch that pauses all agents and revokes outstanding task credentials.
- **FR-S5 (M2):** Prompt-injection defenses, shipping with the first untrusted input. Chat messages, PR comments, issue bodies, and web content are passed to agents as marked untrusted data, never as instructions. They cannot widen a task's scope, permissions, or budget; only an authorized approval can.

## 9. Non-Functional Requirements

- **Reliability:** no lost tasks; safe control-plane restarts; recovery of interrupted runs from the last checkpoint.
- **Latency (targets):** task acknowledged in under 10 seconds; sandbox ready in under 60 seconds for repositories under 1 GB without warm pools (M1), and for all onboarded repositories with warm pools (M3).
- **Scale:** v1 targets 10 to 20 concurrent tasks on a small VM fleet, designed to grow.
- **Extensibility:** new roles, harnesses, and integrations through configuration and adapters.
- **Portability:** no hard dependency on one cloud or model provider.
- **Auditability:** the reasoning behind any PR can be reconstructed from the event log and retained transcripts.
- **Usability:** a new teammate can submit work without training.

## 10. Architecture Overview

```
Chat / Issues / CLI --> Intake --> Postgres (tasks, events, locks, runs, checkpoints)
                                        |
                                Dispatcher / Orchestrator
                                        |
                     Harness adapters (family A, family B, ...)
                                        |
                 Sandbox per task (worktree, scoped token, egress proxy, budget)
                                        |
                  Branch --> rebase + test gate --> PR --> merge queue (human-triggered)
                                        |
                                   Notification

Context repo (decisions, specs, conventions, approval matrix, repo configs)
    <--> Librarian (M4), all agents (read)
```

Initial technology direction: a single-language control plane (TypeScript preferred, Python acceptable), Postgres as queue, state, and audit log, sandboxed containers on VMs, a GitHub App for repository access, and a chat app for intake.

No workflow engine until needed. At 10 to 20 concurrent tasks, a Postgres queue using `SELECT ... FOR UPDATE SKIP LOCKED` with lease timeouts covers dispatch, retries, and recovery. Long waits on humans don't hold workers, because paused tasks are checkpointed rows, not live processes (FR-E6). Revisit if waits, fan-out, or recovery logic outgrow this.

## 11. Core Data Model

- **tasks:** id, parent_id, requester, repo, goal, role, status, priority, budget, decision_id
- **task_events:** append-only log of state changes, messages, routing decisions, approvals, and tool actions
- **locks:** task_id, repo, path glob, mode (advisory)
- **runs:** task_id, harness, model, token counts, dollars, duration, outcome (the cost ledger)
- **checkpoints:** task_id, branch, head sha, transcript ref, harness session ref, created_at
- **decisions:** pointer to the decision record, approver, timestamp
- **identities:** chat id, GitHub login, roles held for approval purposes
- **repos:** repo, onboarding config ref, enabled

## 12. Success Metrics

| Metric | Definition | Why it matters | Target |
|---|---|---|---|
| Cost per merged PR | Total ledger dollars for tasks whose PRs merged, plus failed and abandoned tasks in the same period, divided by merged agent PRs | Primary efficiency measure | Baseline in M1, then reduce through M4 |
| Human review time per PR | Time from review request to merge or close, plus the number of review rounds | Keeps cost cuts from shifting work onto reviewers | Baseline in M2, then trend down |
| Merged without major rework | Share of merged agent PRs with at most one review round and no human-authored commits on the branch | Quality of agent output | Proposed 60% or higher by M3 |
| Time from approval to first PR | Approval timestamp to PR opened | Responsiveness | Baseline in M1 |
| Broken-main incidents from agent PRs | Main fails CI after an agent PR merges | Safety of parallelism | Zero from M3 (merge queue); tracked from M1 |
| Routing accuracy | Share of tasks finished by the first role assigned, without manual reassignment, checked against a weekly human-labeled sample | Router quality | Measured from M1 (rules); proposed 90% or higher for the M4 classifier |
| Uncapped budget overruns | Runs that spent past a hard limit | Cost control | Zero |
| Context freshness | Share of context documents reviewed within their owner's agreed window | Context health | Tracked from M4 |
| Estimate accuracy | Actual cost divided by proposal estimate | Trust in approvals | Within 2x for 80% of tasks by M3 |

All targets are proposals to calibrate after the M1 baseline. Cost per merged PR is never reported alone; it is always shown next to review time and rework rate.

## 13. Milestones

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M0: Contracts** | Envelope schema and status enums (FR-M1, M2); adapter interface including `resume` (FR-X1); agent definition, repo onboarding, and permission schemas (FR-A1, A4, S1); DB migrations including checkpoints; context repo skeleton (FR-C1) | A reviewer can explain from the contracts alone how two agents hand off work and how a paused task resumes |
| **M1: One-task loop** | CLI intake; durable queue; rule-based router; dispatcher; isolated sandbox with scoped token, egress proxy, and limits; one harness adapter; rebase and test gate; PR with standard description; ledger and budgets; event log and transcripts with redaction; secret scanning; kill switch; config validation in CI | One real bug fixed end to end from the CLI, with cost visible and a budget hard stop shown working |
| **M2: Human interface** | Slack intake; concierge; proposals with cost estimates; identity mapping and approval matrix; decision records; checkpoint, pause, and resume; review comments back to workers; notifications and digests; prompt-injection handling; context changes through PRs | A teammate with no training gets a PR out of a chat thread, including at least one `needs_decision` round trip that pauses and resumes |
| **M3: Parallelism** | Planner and task graph; advisory locks and scope verification; merge queue; second harness; cross-family reviewer agent; eval gate; priorities and fair scheduling; warm pools; token optimizers; alerts | Five concurrent tasks on one repo with no broken main or duplicated work, and the eval gate catching a deliberately degraded config |
| **M4: Specialization and economics** | Architect; librarian and freshness tracking; gateway with fallbacks; router classifier and router comparison; cost-per-merged-PR reporting; risk-based reviewer routing; issue-tracker intake; multi-VM scaling | Routing table justified by cost-per-merged-PR, review-time, and rework data |

## 14. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Context rot: stale or wrong entries get repeated by every agent | Review all context changes through PRs (M2), owners and freshness dates and librarian checks (M4) |
| Review fatigue and rubber-stamping | Review-time and rework metrics from M2, reviewer agent pre-checks (M3), WIP caps and risk-based routing (M4), track how often reviews catch real issues |
| Vague approvals | Proposals must be concrete, with explicit assumptions and scope; only authorized approvers count |
| Runaway cost | Hard per-task, per-role, and monthly budgets from M1, retry caps, kill switch, cost shown before approval |
| Over-autonomy | Merge and deploy stay human actions in v1; policy enforced in code |
| Prompt injection through chat, issues, PRs, or web content | Untrusted-data handling from M2, scoped credentials, egress allowlist, strong sandbox isolation, policy in code |
| Sandbox escape or exfiltration from running untrusted code | Isolation stronger than plain containers, default-deny egress, no production credentials, short-lived tokens |
| Declared scope is wrong, so locks miss real conflicts | Locks are advisory; merge queue and test gate protect main; diff-vs-scope check at PR time |
| A model or prompt change silently lowers quality | Eval gate on configuration changes (M3); outcomes tracked in the ledger per model |
| Flaky tests block or falsely pass the gate | Per-repo quarantine list and a fixed flaky-retry count in onboarding config |
| Transcripts leak secrets or sensitive data | Redaction before storage, bounded retention, secret scanning |
| Young dependencies change under us | Keep stable contracts, adapters at the boundaries |
| Routing errors cause costly rework | Simple rules until M4, log every decision and outcome, confidence thresholds and human escalation for the classifier |

## 15. Assumptions and Open Questions

### Assumptions

- Code is hosted on GitHub and chat is Slack. Both are to be confirmed.
- There are no provider, model, or data-residency restrictions.
- The system is built from scratch as a custom control plane, borrowing ideas and small tools rather than adopting a framework wholesale.
- The system is multi-model by design from M0, with a second family running from M3.

### Open Questions

| # | Question | Blocks |
|---|---|---|
| 1 | Control-plane language: TypeScript or Python? | M0 |
| 2 | Which harness and model family comes first? Which second family for cross-review? | M0 (first), M3 (second) |
| 3 | Where do the VMs run (cloud provider, region, sizing), and which sandbox runtime (gVisor, Kata, Firecracker)? | M1 |
| 4 | Which repository and which small, real bug will be the first test case? | M1 |
| 5 | What are the initial budgets per task, per role, and per month? | M1 |
| 6 | Who are the first approvers and reviewers, what may each approve, and how should they be contacted? | M2 |
| 7 | What transcript retention period is acceptable? | M2 (default of 90 days applies until decided) |
| 8 | Where does team knowledge live today, and what should seed the context repo? | M2 (seed), M4 (librarian ingestion) |
| 9 | Which tasks make up the initial eval suite? | M3 |

## 16. Candidate Tools to Evaluate

None of these are commitments. Maturity varies, and several are new or experimental. Each is evaluated against the ledger before adoption.

| Tool | Purpose | Evaluate in |
|---|---|---|
| RTK | Shell-output compression for Claude Code workers | M3 |
| Caveman | Terse-output skill, for internal agent messages only | M3 |
| OpenRig | YAML-defined multi-agent harness, for fast prototyping of the team topology | M0–M1 (prototype only) |
| Jev | Typed decision model for routing, compared against a cheap LLM router using real data | M4 |
| Pi Durable | Experimental durable runtime, a candidate for long-waiting coordination agents | M4, only if checkpointing (FR-E6) proves insufficient |
| Durable workflow engine (for example Temporal) | Orchestration | Only if Postgres-based orchestration becomes insufficient |

## 17. Glossary

- **Harness:** the runtime that wraps a model and gives it tools (for example Claude Code).
- **Envelope:** the typed message format agents use to hand off work.
- **Decision record:** short document capturing an approved decision and its rationale.
- **Role gradient:** ordering of agents from human-facing to code-facing.
- **Ledger:** per-run record of tokens, dollars, and outcome.
- **Checkpoint:** saved branch, transcript, and harness session state that lets a paused task resume in a fresh sandbox.
- **Approval matrix:** the rules in the context repo for who may approve which proposals.
- **Onboarding config:** per-repo settings (toolchain, setup, test, and lint commands, flaky-test policy) required before a repo can receive tasks.
- **Eval gate:** a fixed task suite that configuration changes must pass before they take effect.
- **Advisory lock:** a scheduling hint derived from declared scope; it reduces conflicts but does not guarantee their absence.
