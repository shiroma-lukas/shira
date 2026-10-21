import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { HarnessAdapter, RunOutcome, SessionHandle } from "../contracts/adapter.js";
import {
  Answer,
  Envelope,
  Question,
  Reply,
  type AgentDefinition,
  type ModelChoice,
  type Ref,
  type RepoConfig,
  type TaskStatus,
} from "../contracts/index.js";
import type { LoadedConfig } from "../config/load.js";
import type { Db } from "../db/client.js";
import { exceededBudget, formatUsd, Ledger } from "../ledger/ledger.js";
import { CheckpointStore } from "../queue/checkpoints.js";
import { Settings } from "../queue/settings.js";
import { TaskStore, type Task } from "../queue/store.js";
import type { HarnessAccess, Sandbox, SandboxProvider } from "../sandbox/sandbox.js";
import { scanDiff } from "../security/secrets.js";
import { foreignClosingRefs, neutralizeForGitHub, outOfScope, wrapUntrusted } from "../security/untrusted.js";
import { GitHubError } from "../github/app.js";
import { parseIssueRef, prDescription, prTitle, type CodeHost, type Issue, type IssueTracker } from "./pr.js";

export interface DispatcherDeps {
  db: Db;
  config: LoadedConfig;
  /** Keyed by adapter id, matched against `model.primary.harness` in agent definitions. */
  adapters: ReadonlyMap<string, HarnessAdapter>;
  sandboxes: SandboxProvider;
  /**
   * The model provider's credential and egress for an agent's model choice. Throws when
   * it can't be provided (e.g. a missing key), which fails the task without retrying.
   * Without it, sandboxes get no provider access (tests).
   */
  harnessAccess?: (choice: ModelChoice) => HarnessAccess;
  codeHost: CodeHost;
  /** Revokes the code host credentials this process holds when the kill switch goes on (FR-S4). */
  credentials?: { revokeTokens(): Promise<number> };
  /** Reads issues for the agent and comments on them. Without it, issue links still work but nothing is posted. */
  issues?: IssueTracker;
  /** Loads a role's instructions from the context repo by path. */
  instructions: (path: string) => Promise<string>;
  /** Unique per dispatcher process; recorded as the lease owner. */
  owner: string;
  leaseMs?: number;
  /** How often a running task checks the kill switch. Default 5 s. */
  killPollMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export type TickResult =
  | { kind: "idle" }
  | { kind: "killed" }
  | { kind: "budget_exhausted"; monthSpendUsd: number }
  | { kind: "ran"; taskId: string; status: TaskStatus };

const ZERO_USAGE = (model: string) => ({
  model,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  usd: null,
  durationMs: 0,
});

const tail = (s: string, n = 2000) => (s.length > n ? `...${s.slice(-n)}` : s);

/**
 * Sandbox failures retrying can't fix: the repo or its credentials are wrong, egress is
 * misconfigured, or the image doesn't exist. Anything else (daemon hiccup, network) retries.
 */
const PERMANENT_SANDBOX_ERROR =
  /\b(401|403|404)\b|Authentication failed|Repository not found|could not read Username|Proxy CONNECT aborted|not on network|No such image|pull access denied/i;

const isPermanentGitHubError = (err: unknown) => err instanceof GitHubError && err.permanent;

/**
 * The issue comment for a paused task: the question, its options numbered as `--choice`
 * expects (from 0), and the command that answers it. Answering from a comment needs
 * webhooks (M2).
 */
export function decisionComment(taskId: string, short: string, raw: unknown): string {
  const q = Question.safeParse(raw);
  if (!q.success) return `Shira needs a decision to continue (${short}). See \`shira show ${taskId}\`.`;
  // Agent-written, so possibly steered by untrusted input: neutralized before posting.
  const safe = neutralizeForGitHub;
  const lines = [`Shira needs a ${q.data.kind} decision to continue (${short}):`, "", `> ${safe(q.data.text)}`];
  if (q.data.options?.length) lines.push("", ...q.data.options.map((o, i) => `- \`${i}\`: ${safe(o)}`));
  const choice = q.data.options?.length ? " --choice <n>" : "";
  lines.push("", "Answer with:", "", "```", `shira answer ${taskId} --text "..."${choice}`, "```");
  return lines.join("\n");
}

/** A PR whose branch passed the gate and was pushed, waiting to be opened. */
interface PendingPr {
  type: "pr_pending";
  head: string;
  base: string;
  title: string;
  body: string;
  reply_id: string;
}
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
  private readonly killPollMs: number;
  private readonly settings: Settings;
  /** Set once this process has revoked its credentials for the current kill; cleared when it's lifted. */
  private revokedForKill = false;
  private readonly log: NonNullable<DispatcherDeps["log"]>;

  constructor(private readonly deps: DispatcherDeps) {
    this.store = new TaskStore(deps.db);
    this.ledger = new Ledger(deps.db);
    this.checkpoints = new CheckpointStore(deps.db);
    this.leaseMs = deps.leaseMs ?? 60_000;
    this.killPollMs = deps.killPollMs ?? 5_000;
    this.settings = new Settings(deps.db);
    this.log = deps.log ?? ((m, f) => console.log(m, f ?? ""));
  }

  /** Claims and runs at most one task. */
  async tick(): Promise<TickResult> {
    await this.store.reapExpiredLeases(this.deps.owner);

    // Kill switch (FR-S4): claim nothing, and revoke the credentials this process holds.
    // Running tasks notice on their own (supervise) and pause.
    if (await this.settings.agentsPaused()) {
      if (!this.revokedForKill) {
        this.revokedForKill = true;
        const revoked = await this.deps.credentials?.revokeTokens().catch((err: Error) => {
          this.revokedForKill = false; // try again on the next tick
          this.log("kill switch: revoking credentials failed", { error: err.message });
          return null;
        });
        if (revoked !== null) this.log("kill switch: credentials revoked", { tokens: revoked ?? 0 });
      }
      return { kind: "killed" };
    }
    this.revokedForKill = false;

    const monthly = await this.settings.monthlyBudgetUsd();
    if (monthly !== null) {
      const spent = await this.ledger.monthSpendUsd();
      if (spent >= monthly) return { kind: "budget_exhausted", monthSpendUsd: spent };
    }

    const task = await this.store.claim(this.deps.owner, this.leaseMs);
    if (!task) return { kind: "idle" };
    this.log("claimed", { task: task.id, attempt: task.attempts });

    try {
      const status = await this.execute(task);
      await this.notifyIssue(task, status).catch((err) => this.log("issue comment failed", { error: (err as Error).message }));
      return { kind: "ran", taskId: task.id, status };
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

  /**
   * Runs `concurrency` independent claim loops until `signal` aborts, each sleeping
   * `idleMs` when there is nothing to do. The queue hands each task to one loop only,
   * and leases are per task, so the loops need no coordination. On abort, loops stop
   * claiming and the call resolves once every in-flight task has finished.
   */
  async run(signal: AbortSignal, idleMs = 2000, concurrency = 1): Promise<void> {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("concurrency must be a positive integer");
    const loop = async () => {
      while (!signal.aborted) {
        const r = await this.tick();
        if (r.kind !== "ran") await sleep(idleMs, undefined, { signal }).catch(() => {});
      }
    };
    await Promise.all(Array.from({ length: concurrency }, loop));
  }

  private retry(task: Task, reason: string) {
    return this.store.retryOrFail(task.id, this.deps.owner, reason);
  }

  private fail(task: Task, payload: Record<string, unknown>) {
    return this.store.transition(task.id, "failed", { actor: this.deps.owner, from: "running", payload });
  }

  /** Fails without retrying: the cause is configuration, and another attempt would fail the same way. */
  private failPermanently(task: Task, reason: string) {
    return this.fail(task, { reason, permanent: true });
  }

  private async execute(task: Task): Promise<TaskStatus> {
    const { config, adapters } = this.deps;
    const agent = config.agents.find((a) => a.role === task.role);
    if (!agent) return (await this.fail(task, { reason: `no agent definition for role ${task.role}` })).status;
    const repo = config.repos.find((r) => r.repo === task.repo);
    if (!repo) return (await this.fail(task, { reason: `repo ${task.repo} has no onboarding config` })).status;
    const adapter = adapters.get(agent.model.primary.harness);
    if (!adapter) return (await this.fail(task, { reason: `no adapter for harness ${agent.model.primary.harness}` })).status;

    // The branch already passed the gate and was pushed; only opening the PR failed.
    const pending = await this.pendingPr(task.id);
    if (pending) return this.openPr(task, pending);

    const spend = await this.ledger.taskSpend(task.id);
    const over = exceededBudget(task.budget, spend);
    if (over) return (await this.fail(task, { reason: "budget_exceeded", dimension: over, spend })).status;

    const envelope = await this.envelopeFor(task, repo);
    const checkpoint = await this.checkpoints.latest(task.id, task.repo);
    const answer = await this.pendingAnswer(task.id);
    const branch = checkpoint?.branch ?? `shira/${task.id.slice(0, 8)}`;

    let harness: HarnessAccess | undefined;
    try {
      harness = this.deps.harnessAccess?.(agent.model.primary);
    } catch (err) {
      return (await this.failPermanently(task, `model provider: ${(err as Error).message}`)).status;
    }

    let sandbox: Sandbox;
    try {
      sandbox = await this.deps.sandboxes.create({ taskId: task.id, repo, branch, checkpointSha: checkpoint?.head_sha, harness });
    } catch (err) {
      const message = `sandbox: ${(err as Error).message}`;
      if (PERMANENT_SANDBOX_ERROR.test(message)) return (await this.failPermanently(task, message)).status;
      return (await this.retry(task, message)).status;
    }

    try {
      for (const cmd of repo.setup) {
        const r = await sandbox.exec(cmd);
        if (r.code !== 0) return (await this.retry(task, `setup failed: ${cmd}: ${tail(r.stderr, 500)}`)).status;
      }

      let attachments;
      try {
        attachments = await this.attach(task, sandbox);
      } catch (err) {
        const message = `reading the task's issue failed: ${(err as Error).message}`;
        if (isPermanentGitHubError(err)) return (await this.failPermanently(task, message)).status;
        return (await this.retry(task, message)).status;
      }

      // Setup can take minutes; don't start the agent if the kill switch went on meanwhile.
      if (await this.settings.agentsPaused()) return (await this.pauseForKill(task, "before the run")).status;

      const { model, provider } = agent.model.primary;
      const run = await this.ledger.startRun({ taskId: task.id, role: task.role, harness: adapter.id, model });
      const input = {
        runId: run.id,
        envelope,
        workspace: sandbox.workspace,
        launch: sandbox.launch,
        model,
        provider,
        instructions: await this.deps.instructions(agent.instructions),
        tools: agent.tools,
        remaining: { usd: task.budget.usd - spend.usd },
        attachments,
      };
      const session = checkpoint
        ? await adapter.resume({ ...input, checkpoint, ...(await this.openQuestion(task.id, answer)) })
        : await adapter.start(input);

      const limitMs = Math.min(task.budget.minutes - spend.minutes, repo.limits.minutes) * 60_000;
      const { outcome, stopped } = await this.supervise(task, adapter, session, limitMs, model);
      await this.ledger.finishRun(run.id, outcome);
      this.log("run finished", { task: task.id, run: run.id, outcome: outcome.kind === "reply" ? outcome.reply.status : outcome.reason });

      if (stopped === "cancelled") return (await this.store.get(task.id))!.status;
      // Even if the agent finished at the same moment: nothing is pushed while the switch is on.
      if (stopped === "killed") return (await this.pauseForKill(task, "during the run")).status;
      if (outcome.kind === "aborted") {
        if (outcome.reason === "timeout" || outcome.reason === "budget_exceeded") {
          return (await this.fail(task, { reason: outcome.reason, detail: outcome.detail })).status;
        }
        if (outcome.reason === "config_error") {
          return (await this.failPermanently(task, `harness configuration: ${outcome.detail ?? "rejected"}`)).status;
        }
        return (await this.retry(task, `${outcome.reason}: ${outcome.detail ?? "no detail"}`)).status;
      }
      return await this.settle(task, envelope, repo, agent, adapter, sandbox, run, outcome);
    } finally {
      await sandbox.destroy().catch((err) => this.log("sandbox destroy failed", { error: (err as Error).message }));
    }
  }

  /**
   * Kill switch (FR-S4): the task goes to `paused` without using a retry. The sandbox is
   * destroyed on the way out, which revokes its egress grant and cuts open connections.
   * `shira resume` requeues it once the switch is off.
   */
  private pauseForKill(task: Task, stage: string) {
    this.log("kill switch: task paused", { task: task.id, stage });
    return this.store.transition(task.id, "paused", { actor: this.deps.owner, from: "running", payload: { reason: "kill switch", stage } });
  }

  /** Waits for the run, renewing the lease, enforcing the time limit, and watching the kill switch. */
  private async supervise(
    task: Task,
    adapter: HarnessAdapter,
    session: SessionHandle,
    limitMs: number,
    model: string,
  ): Promise<{ outcome: RunOutcome; stopped: "cancelled" | "timeout" | "killed" | null }> {
    let stopped: "cancelled" | "timeout" | "killed" | null = null;
    const stop = (why: "cancelled" | "timeout" | "killed") => {
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
    const killWatch = setInterval(() => {
      this.settings
        .agentsPaused()
        .then((paused) => paused && stop("killed"))
        .catch((err) => this.log("kill switch check failed", { error: (err as Error).message }));
    }, this.killPollMs);

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
      clearInterval(killWatch);
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
    // Scope is enforced here, not only stated in the prompt: no text the agent read can widen
    // it (FR-S5). Never pushed, no retry: a human decides whether the scope was wrong.
    const changed = (await git(`git diff --name-only ${range}`)).stdout.split("\n").filter(Boolean);
    const outside = outOfScope(changed, task.scope.paths);
    if (outside.length) {
      return (await this.fail(task, { reason: "changes outside the task's scope", paths: outside.slice(0, 50), scope: task.scope.paths })).status;
    }
    // GitHub acts on closing keywords in commit messages at merge: only the task's own issue may be named.
    const issueRef = this.issueOf(task);
    const messages = (await git(`git log --format=%B ${q(`origin/${base}`)}..HEAD`)).stdout;
    const refs = foreignClosingRefs(messages, issueRef?.repo === task.repo ? issueRef.number : undefined);
    if (refs.length) {
      return (await this.fail(task, { reason: "commit messages close other issues", refs: refs.slice(0, 20) })).status;
    }
    const diffStat = (await git(`git diff --stat ${range}`)).stdout;

    if (await this.settings.agentsPaused()) return (await this.pauseForKill(task, "before push")).status;
    const push = await sandbox.exec(`git push --quiet -f origin HEAD:refs/heads/${q(branch)}`, { auth: "write" });
    if (push.code !== 0) return (await this.retry(task, `push failed: ${tail(push.stderr, 500)}`)).status;

    const spend = await this.ledger.taskSpend(task.id);
    const issue = this.issueOf(task);
    const pending: PendingPr = {
      type: "pr_pending",
      head: branch,
      base,
      title: prTitle(task, reply.title),
      body: prDescription({
        task,
        summary: reply.summary,
        closes: issue?.repo === task.repo ? issue.number : undefined,
        testCommand: repo.test,
        testAttempts,
        diffStat,
        spend,
        runs: run.attempt,
        transcripts: (await this.ledger.runs(task.id))
          .filter((r) => r.transcriptUri && r.transcriptUri !== "none")
          .map((r) => ({ attempt: r.attempt, uri: r.transcriptUri! })),
      }),
      reply_id: reply.id,
    };
    // Recorded before opening: if opening fails, a retry opens this PR instead of re-running the agent.
    await this.store.record(task.id, "note", this.deps.owner, { ...pending });
    return this.openPr(task, pending);
  }

  private async openPr(task: Task, pending: PendingPr): Promise<TaskStatus> {
    // The pending note is recorded, so a resume opens this PR without re-running the agent.
    if (await this.settings.agentsPaused()) return (await this.pauseForKill(task, "before opening the PR")).status;
    let pr;
    try {
      pr = await this.deps.codeHost.openPullRequest({
        repo: task.repo,
        head: pending.head,
        base: pending.base,
        title: pending.title,
        body: pending.body,
      });
    } catch (err) {
      const message = `opening PR failed: ${(err as Error).message}`;
      if (isPermanentGitHubError(err)) return (await this.failPermanently(task, message)).status;
      return (await this.retry(task, message)).status;
    }
    const t = await this.store.transition(task.id, "done", {
      actor: this.deps.owner,
      from: "running",
      payload: { pr: { repo: task.repo, number: pr.number, url: pr.url }, reply_id: pending.reply_id },
    });
    return t.status;
  }

  private async pendingPr(taskId: string): Promise<PendingPr | null> {
    const { rows } = await this.deps.db.query<{ payload: PendingPr }>(
      `SELECT payload FROM task_events
       WHERE task_id = $1 AND kind = 'note' AND payload->>'type' = 'pr_pending'
       ORDER BY id DESC LIMIT 1`,
      [taskId],
    );
    return rows[0]?.payload ?? null;
  }

  /** The issue a task resolves, when it came from one. */
  private issueOf(task: Task): { repo: string; number: number } | null {
    const ref = task.threadRef;
    return ref?.kind === "thread" && ref.provider === "github" ? parseIssueRef(ref.id) : null;
  }

  /** Writes the task's issue into the sandbox, since the agent can't read private issues itself. */
  private async attach(task: Task, sandbox: Sandbox) {
    const ref = this.issueOf(task);
    if (!ref || !this.deps.issues || !task.threadRef) return [];
    const issue: Issue = await this.deps.issues.getIssue(ref.repo, ref.number);
    // Anyone who can open an issue wrote this, so it reaches the agent as marked data (FR-S5).
    const path = await sandbox.writeFile(
      `issue-${issue.number}.md`,
      wrapUntrusted(
        { source: `GitHub issue ${ref.repo}#${issue.number}`, author: issue.author, url: issue.url },
        `# ${issue.title}\n\n${issue.body || "(no description)"}`,
      ),
    );
    return [{ ref: task.threadRef, path, untrusted: true }];
  }

  /** Tells the issue what happened: the PR, the question that needs answering, or why the task failed. */
  private async notifyIssue(task: Task, status: TaskStatus): Promise<void> {
    const ref = this.issueOf(task);
    if (!ref || !this.deps.issues || !["done", "failed", "needs_decision"].includes(status)) return;
    const last = (await this.store.events(task.id)).findLast((e) => e.kind === "state_change");
    const spend = await this.ledger.taskSpend(task.id);
    const cost = `${formatUsd(spend)}, ${spend.tokens.toLocaleString("en-US")} tokens`;
    const short = `task \`${task.id.slice(0, 8)}\``;
    let body: string;
    if (status === "done") {
      body = `Opened #${(last?.payload.pr as { number: number }).number} to fix this (${short}, ${cost}).`;
    } else if (status === "needs_decision") {
      body = decisionComment(task.id, short, last?.payload.question);
    } else {
      // Reasons can quote test output or agent text.
      const reason = neutralizeForGitHub(String(last?.payload.reason ?? "unknown reason").slice(0, 500));
      body = `Shira couldn't complete this (${short}, ${cost}):\n\n> ${reason}`;
    }
    await this.deps.issues.comment(ref.repo, ref.number, body);
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
