import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { HarnessAdapter, RunOutcome, SessionHandle } from "../contracts/adapter.js";
import {
  Answer,
  Envelope,
  Question,
  Reply,
  type AgentDefinition,
  type Ref,
  type RepoConfig,
  type TaskStatus,
} from "../contracts/index.js";
import type { LoadedConfig } from "../config/load.js";
import type { Db } from "../db/client.js";
import { exceededBudget, Ledger } from "../ledger/ledger.js";
import { CheckpointStore } from "../queue/checkpoints.js";
import { Settings } from "../queue/settings.js";
import { TaskStore, type Task } from "../queue/store.js";
import type { Sandbox, SandboxProvider } from "../sandbox/sandbox.js";
import { scanDiff } from "../security/secrets.js";
import { prDescription, prTitle, type CodeHost } from "./pr.js";

export interface DispatcherDeps {
  db: Db;
  config: LoadedConfig;
  /** Keyed by adapter id, matched against `model.primary.harness` in agent definitions. */
  adapters: ReadonlyMap<string, HarnessAdapter>;
  sandboxes: SandboxProvider;
  codeHost: CodeHost;
  /** Loads a role's instructions from the context repo by path. */
  instructions: (path: string) => Promise<string>;
  /** Unique per dispatcher process; recorded as the lease owner. */
  owner: string;
  leaseMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export type TickResult =
  | { kind: "idle" }
  | { kind: "budget_exhausted"; monthSpendUsd: number }
  | { kind: "ran"; taskId: string; status: TaskStatus };

const ZERO_USAGE = (model: string) => ({
  model,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  usd: 0,
  durationMs: 0,
});

const tail = (s: string, n = 2000) => (s.length > n ? `...${s.slice(-n)}` : s);
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Runs one task at a time from claim to PR (M1). Many dispatchers can run side by
 * side; the queue guarantees each task is claimed once.
 *
 * Budgets: time is enforced during the run (the session is cancelled at the limit).
 * Tokens and dollars are checked before each run, from the ledger. Stopping a run
 * mid-way on tokens or dollars needs streaming usage from the adapter and comes with
 * the first real adapter.
 */
export class Dispatcher {
  private readonly store: TaskStore;
  private readonly ledger: Ledger;
  private readonly checkpoints: CheckpointStore;
  private readonly leaseMs: number;
  private readonly log: NonNullable<DispatcherDeps["log"]>;

  constructor(private readonly deps: DispatcherDeps) {
    this.store = new TaskStore(deps.db);
    this.ledger = new Ledger(deps.db);
    this.checkpoints = new CheckpointStore(deps.db);
    this.leaseMs = deps.leaseMs ?? 60_000;
    this.log = deps.log ?? ((m, f) => console.log(m, f ?? ""));
  }

  /** Claims and runs at most one task. */
  async tick(): Promise<TickResult> {
    await this.store.reapExpiredLeases(this.deps.owner);

    const monthly = await new Settings(this.deps.db).monthlyBudgetUsd();
    if (monthly !== null) {
      const spent = await this.ledger.monthSpendUsd();
      if (spent >= monthly) return { kind: "budget_exhausted", monthSpendUsd: spent };
    }

    const task = await this.store.claim(this.deps.owner, this.leaseMs);
    if (!task) return { kind: "idle" };
    this.log("claimed", { task: task.id, attempt: task.attempts });

    try {
      return { kind: "ran", taskId: task.id, status: await this.execute(task) };
    } catch (err) {
      // Infrastructure failure (database, sandbox host). Count it as a failed attempt if
      // we still hold the task; otherwise the lease reaper will.
      this.log("dispatch error", { task: task.id, error: (err as Error).message });
      const cur = await this.store.get(task.id);
      if (cur?.status === "running" && cur.leaseOwner === this.deps.owner) {
        return { kind: "ran", taskId: task.id, status: (await this.retry(task, `dispatch error: ${(err as Error).message}`)).status };
      }
      return { kind: "ran", taskId: task.id, status: cur?.status ?? "failed" };
    }
  }

  /** Loops until `signal` aborts, sleeping `idleMs` when there is nothing to do. */
  async run(signal: AbortSignal, idleMs = 2000): Promise<void> {
    while (!signal.aborted) {
      const r = await this.tick();
      if (r.kind !== "ran") await sleep(idleMs, undefined, { signal }).catch(() => {});
    }
  }

  private retry(task: Task, reason: string) {
    return this.store.retryOrFail(task.id, this.deps.owner, reason);
  }

  private fail(task: Task, payload: Record<string, unknown>) {
    return this.store.transition(task.id, "failed", { actor: this.deps.owner, from: "running", payload });
  }

  private async execute(task: Task): Promise<TaskStatus> {
    const { config, adapters } = this.deps;
    const agent = config.agents.find((a) => a.role === task.role);
    if (!agent) return (await this.fail(task, { reason: `no agent definition for role ${task.role}` })).status;
    const repo = config.repos.find((r) => r.repo === task.repo);
    if (!repo) return (await this.fail(task, { reason: `repo ${task.repo} has no onboarding config` })).status;
    const adapter = adapters.get(agent.model.primary.harness);
    if (!adapter) return (await this.fail(task, { reason: `no adapter for harness ${agent.model.primary.harness}` })).status;

    const spend = await this.ledger.taskSpend(task.id);
    const over = exceededBudget(task.budget, spend);
    if (over) return (await this.fail(task, { reason: "budget_exceeded", dimension: over, spend })).status;

    const envelope = await this.envelopeFor(task, repo);
    const checkpoint = await this.checkpoints.latest(task.id, task.repo);
    const answer = await this.pendingAnswer(task.id);
    const branch = checkpoint?.branch ?? `shira/${task.id.slice(0, 8)}`;

    let sandbox: Sandbox;
    try {
      sandbox = await this.deps.sandboxes.create({ taskId: task.id, repo, branch, checkpointSha: checkpoint?.head_sha });
    } catch (err) {
      return (await this.retry(task, `sandbox: ${(err as Error).message}`)).status;
    }

    try {
      for (const cmd of repo.setup) {
        const r = await sandbox.exec(cmd);
        if (r.code !== 0) return (await this.retry(task, `setup failed: ${cmd}: ${tail(r.stderr, 500)}`)).status;
      }

      const model = agent.model.primary.model;
      const run = await this.ledger.startRun({ taskId: task.id, role: task.role, harness: adapter.id, model });
      const input = {
        runId: run.id,
        envelope,
        workspace: sandbox.workspace,
        launch: sandbox.launch,
        model,
        instructions: await this.deps.instructions(agent.instructions),
        tools: agent.tools,
        remaining: { usd: task.budget.usd - spend.usd },
      };
      const session = checkpoint
        ? await adapter.resume({ ...input, checkpoint, ...(await this.openQuestion(task.id, answer)) })
        : await adapter.start(input);

      const limitMs = Math.min(task.budget.minutes - spend.minutes, repo.limits.minutes) * 60_000;
      const { outcome, stopped } = await this.supervise(task, adapter, session, limitMs, model);
      await this.ledger.finishRun(run.id, outcome);
      this.log("run finished", { task: task.id, run: run.id, outcome: outcome.kind === "reply" ? outcome.reply.status : outcome.reason });

      if (stopped === "cancelled") return (await this.store.get(task.id))!.status;
      if (outcome.kind === "aborted") {
        if (outcome.reason === "timeout" || outcome.reason === "budget_exceeded") {
          return (await this.fail(task, { reason: outcome.reason, detail: outcome.detail })).status;
        }
        return (await this.retry(task, `${outcome.reason}: ${outcome.detail ?? "no detail"}`)).status;
      }
      return await this.settle(task, envelope, repo, agent, adapter, sandbox, run, outcome);
    } finally {
      await sandbox.destroy().catch((err) => this.log("sandbox destroy failed", { error: (err as Error).message }));
    }
  }

  /** Waits for the run, renewing the lease and enforcing the time limit. */
  private async supervise(
    task: Task,
    adapter: HarnessAdapter,
    session: SessionHandle,
    limitMs: number,
    model: string,
  ): Promise<{ outcome: RunOutcome; stopped: "cancelled" | "timeout" | null }> {
    let stopped: "cancelled" | "timeout" | null = null;
    const stop = (why: "cancelled" | "timeout") => {
      if (stopped) return;
      stopped = why;
      adapter.cancel(session).catch((err) => this.log("cancel failed", { error: (err as Error).message }));
    };
    const timer = setTimeout(() => stop("timeout"), Math.max(limitMs, 0));
    const renewal = setInterval(() => {
      this.store
        .renewLease(task.id, this.deps.owner, this.leaseMs)
        .then((held) => held || stop("cancelled"))
        .catch((err) => this.log("lease renewal failed", { error: (err as Error).message }));
    }, this.leaseMs / 3);

    let outcome: RunOutcome;
    try {
      outcome = await adapter.result(session);
    } catch (err) {
      outcome = {
        kind: "aborted",
        reason: "error",
        detail: (err as Error).message,
        usage: ZERO_USAGE(model),
        transcriptUri: "none",
        sessionRef: session.sessionRef,
      };
    } finally {
      clearTimeout(timer);
      clearInterval(renewal);
    }
    // The adapter may report a cancellation we caused as an error; the platform's reason wins.
    if (stopped === "timeout" && outcome.kind === "aborted") outcome = { ...outcome, reason: "timeout" };
    return { outcome, stopped };
  }

  private async settle(
    task: Task,
    envelope: Envelope,
    repo: RepoConfig,
    agent: AgentDefinition,
    adapter: HarnessAdapter,
    sandbox: Sandbox,
    run: { id: string; attempt: number },
    outcome: Extract<RunOutcome, { kind: "reply" }>,
  ): Promise<TaskStatus> {
    const parsed = Reply.safeParse(outcome.reply);
    const problem = !parsed.success
      ? parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
      : parsed.data.task_id !== task.id
        ? "reply is for another task"
        : parsed.data.in_reply_to !== envelope.id
          ? "reply does not answer this task's envelope"
          : parsed.data.from !== agent.role
            ? `reply from ${parsed.data.from}, expected ${agent.role}`
            : null;
    if (problem || !parsed.success) return (await this.retry(task, `invalid reply: ${problem}`)).status;
    const reply = parsed.data;
    await this.store.record(task.id, "message", agent.role, { type: "reply", reply });

    switch (reply.status) {
      case "failed":
        return (await this.fail(task, { reason: "agent reported failure", summary: reply.summary, reply_id: reply.id })).status;
      case "needs_decision":
      case "blocked":
        return this.pause(task, reply, adapter, sandbox, run, outcome);
      case "done":
        return this.gateAndOpenPr(task, reply, repo, sandbox, run);
    }
  }

  /** Commits and pushes work in progress, then checkpoints and pauses in one transaction (FR-E6). */
  private async pause(
    task: Task,
    reply: Reply,
    adapter: HarnessAdapter,
    sandbox: Sandbox,
    run: { id: string },
    outcome: RunOutcome,
  ): Promise<TaskStatus> {
    const branch = sandbox.workspace.branch;
    const saved = await sandbox.exec(
      `git add -A && (git diff --cached --quiet || git commit --quiet -m "shira: checkpoint") && git push --quiet -f origin HEAD:refs/heads/${q(branch)}`,
      { auth: "write" },
    );
    if (saved.code !== 0) return (await this.retry(task, `checkpoint push failed: ${tail(saved.stderr, 500)}`)).status;
    const head = (await sandbox.exec("git rev-parse HEAD")).stdout.trim();

    const to = reply.status === "needs_decision" ? "needs_decision" : "blocked";
    const t = await this.store.transition(
      task.id,
      to,
      { actor: this.deps.owner, from: "running", payload: { reply_id: reply.id, question: reply.question, blocked_by: reply.blocked_by } },
      (tx) =>
        new CheckpointStore(tx).save({
          task_id: task.id,
          run_id: run.id,
          harness: adapter.id,
          repo: task.repo,
          branch,
          head_sha: head,
          transcript_uri: outcome.transcriptUri,
          session_ref: outcome.sessionRef,
          created_at: new Date().toISOString(),
        }),
    );
    return t.status;
  }

  /** Rebase, test, secret scan, push, and open the PR (FR-O3, FR-S2, FR-H4). */
  private async gateAndOpenPr(
    task: Task,
    reply: Reply,
    repo: RepoConfig,
    sandbox: Sandbox,
    run: { attempt: number },
  ): Promise<TaskStatus> {
    const base = repo.defaultBranch;
    const branch = sandbox.workspace.branch;
    const git = (cmd: string) => sandbox.exec(cmd);

    const head = (await git("git rev-parse HEAD")).stdout.trim();
    if (reply.artifact?.kind !== "commit" || reply.artifact.sha !== head) {
      return (await this.retry(task, "done reply must name the branch HEAD commit as its artifact")).status;
    }
    if ((await git("git status --porcelain")).stdout.trim()) {
      return (await this.retry(task, "uncommitted changes left in the workspace")).status;
    }

    await sandbox.exec(`git fetch --quiet origin ${q(base)}`, { auth: "read" });
    if ((await git(`git rev-list --count ${q(`origin/${base}`)}..HEAD`)).stdout.trim() === "0") {
      return (await this.fail(task, { reason: "no changes to propose", reply_id: reply.id })).status;
    }
    const rebase = await git(`git rebase --quiet ${q(`origin/${base}`)}`);
    if (rebase.code !== 0) {
      await git("git rebase --abort");
      // M1 escalates conflicts to a human; automated resolution comes with the planner (M3).
      return (await this.fail(task, { reason: "rebase conflict", detail: tail(rebase.stderr + rebase.stdout, 1000) })).status;
    }

    let testAttempts = 0;
    let test;
    do {
      testAttempts++;
      test = await sandbox.exec(repo.test, { timeoutMs: repo.limits.minutes * 60_000 });
    } while (test.code !== 0 && testAttempts <= repo.flaky.retries);
    if (test.code !== 0) {
      return (await this.retry(task, `tests failed after rebase: ${tail(test.stdout + test.stderr, 1500)}`)).status;
    }

    const range = `${q(`origin/${base}`)}...HEAD`;
    const findings = scanDiff((await git(`git diff ${range}`)).stdout);
    if (findings.length) {
      // Never pushed. No retry: the agent produced a credential, a human must look.
      return (await this.fail(task, { reason: "secret detected in diff", findings })).status;
    }
    const diffStat = (await git(`git diff --stat ${range}`)).stdout;

    const push = await sandbox.exec(`git push --quiet -f origin HEAD:refs/heads/${q(branch)}`, { auth: "write" });
    if (push.code !== 0) return (await this.retry(task, `push failed: ${tail(push.stderr, 500)}`)).status;

    const spend = await this.ledger.taskSpend(task.id);
    let pr;
    try {
      pr = await this.deps.codeHost.openPullRequest({
        repo: task.repo,
        head: branch,
        base,
        title: prTitle(task),
        body: prDescription({ task, summary: reply.summary, testCommand: repo.test, testAttempts, diffStat, spend, runs: run.attempt }),
      });
    } catch (err) {
      return (await this.retry(task, `opening PR failed: ${(err as Error).message}`)).status;
    }
    const t = await this.store.transition(task.id, "done", {
      actor: this.deps.owner,
      from: "running",
      payload: { pr: { repo: task.repo, number: pr.number, url: pr.url }, reply_id: reply.id },
    });
    return t.status;
  }

  /** The task's envelope. Created on first dispatch and reused on resume, so replies keep answering it. */
  private async envelopeFor(task: Task, repo: RepoConfig): Promise<Envelope> {
    const { rows } = await this.deps.db.query<{ payload: { envelope: unknown } }>(
      `SELECT payload FROM task_events
       WHERE task_id = $1 AND kind = 'message' AND payload->>'type' = 'envelope'
       ORDER BY id DESC LIMIT 1`,
      [task.id],
    );
    if (rows[0]) return Envelope.parse(rows[0].payload.envelope);

    const refs: Ref[] = [...task.contextRefs];
    if (task.threadRef) refs.push(task.threadRef);
    if (task.decisionId) refs.push({ kind: "decision", id: task.decisionId });
    const envelope = Envelope.parse({
      v: 1,
      id: randomUUID(),
      task_id: task.id,
      from: "orchestrator",
      to: task.role,
      goal: task.goal,
      refs,
      scope: task.scope,
      done_when: ["Changes committed on the task branch", `\`${repo.test}\` passes`],
      budget: task.budget,
    });
    await this.store.record(task.id, "message", "orchestrator", { type: "envelope", envelope });
    return envelope;
  }

  /** The question and answer to hand a resumed run, if the task was paused on a decision. */
  private async openQuestion(taskId: string, answer: Answer | undefined): Promise<{ question?: Question; answer?: Answer }> {
    if (!answer) return {};
    const { rows } = await this.deps.db.query<{ payload: { question?: unknown } }>(
      `SELECT payload FROM task_events
       WHERE task_id = $1 AND kind = 'state_change' AND to_status = 'needs_decision'
       ORDER BY id DESC LIMIT 1`,
      [taskId],
    );
    const question = Question.safeParse(rows[0]?.payload.question);
    return question.success ? { question: question.data, answer } : { answer };
  }

  /** The answer that requeued this task, if it was requeued from needs_decision. */
  private async pendingAnswer(taskId: string): Promise<Answer | undefined> {
    const { rows } = await this.deps.db.query<{ from_status: string; payload: { answer?: unknown } }>(
      `SELECT from_status, payload FROM task_events
       WHERE task_id = $1 AND kind = 'state_change' AND to_status = 'queued'
       ORDER BY id DESC LIMIT 1`,
      [taskId],
    );
    const r = rows[0];
    return r?.from_status === "needs_decision" && r.payload.answer ? Answer.parse(r.payload.answer) : undefined;
  }
}
