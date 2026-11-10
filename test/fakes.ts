import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessAdapter, ResumeInput, RunOutcome, SessionHandle, StartInput } from "../src/contracts/adapter.js";
import type { Reply } from "../src/contracts/index.js";
import type { CodeHost, Issue, IssueTracker, PullRequestInfo, PullRequests, Review, ReviewComment } from "../src/dispatcher/pr.js";
import { sh } from "../src/sandbox/process.js";

export type StepInput = (StartInput | ResumeInput) & {
  exec: (cmd: string) => Promise<string>;
  /** Resolves when the platform cancels this session. */
  cancelled: Promise<void>;
};

/** What a scripted step returns: reply fields (ids filled in), or a ready-made outcome. */
export type Step = (input: StepInput) => Promise<Partial<Reply> & Pick<Reply, "status" | "summary"> | RunOutcome>;

const usage = { model: "fake", inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0.1, durationMs: 1000 };

/** A harness that runs one scripted step per start/resume, in order. */
export class ScriptedAdapter implements HarnessAdapter {
  readonly id = "fake";
  readonly capabilities = { nativeResume: true };
  readonly calls: { kind: "start" | "resume"; input: StartInput | ResumeInput }[] = [];
  private readonly sessions = new Map<string, { result: Promise<RunOutcome>; cancel: () => void }>();

  constructor(private readonly steps: Step[]) {}

  start(input: StartInput) {
    return this.begin("start", input);
  }

  resume(input: ResumeInput) {
    return this.begin("resume", input);
  }

  private async begin(kind: "start" | "resume", input: StartInput | ResumeInput): Promise<SessionHandle> {
    this.calls.push({ kind, input });
    const step = this.steps.shift();
    if (!step) throw new Error("no scripted step left");
    let cancel!: () => void;
    const cancelled = new Promise<void>((r) => (cancel = r));
    const exec = async (cmd: string) => {
      const r = await sh(cmd, input.workspace.path);
      if (r.code !== 0) throw new Error(`${cmd}: ${r.stderr}`);
      return r.stdout.trim();
    };
    const sessionRef = `fake-${randomUUID()}`;
    const result = Promise.race([
      step({ ...input, exec, cancelled }).then((r): RunOutcome =>
        "kind" in r
          ? r
          : {
              kind: "reply",
              usage,
              transcriptUri: `file:///transcripts/${input.runId}`,
              sessionRef,
              reply: { v: 1, id: randomUUID(), task_id: input.envelope.task_id, in_reply_to: input.envelope.id, from: "worker", ...r } as Reply,
            },
      ),
      cancelled.then((): RunOutcome => ({ kind: "aborted", reason: "cancelled", usage, transcriptUri: "file:///t", sessionRef })),
    ]);
    this.sessions.set(input.runId, { result, cancel });
    return { harness: this.id, runId: input.runId, sessionRef };
  }

  async send() {}

  async cancel(s: SessionHandle) {
    this.sessions.get(s.runId)?.cancel();
  }

  result(s: SessionHandle) {
    return this.sessions.get(s.runId)!.result;
  }
}

export class FakeCodeHost implements CodeHost, IssueTracker, PullRequests {
  readonly prs: { repo: string; head: string; base: string; title: string; body: string }[] = [];
  /** Set to read PR head commits from a real origin repo. */
  origin?: string;
  readonly prStates = new Map<number, "open" | "closed">();
  /** Reviews per PR number, and inline comments per review id. */
  readonly reviews = new Map<number, Review[]>();
  readonly reviewCommentsById = new Map<number, ReviewComment[]>();
  readonly comments: { repo: string; number: number; body: string }[] = [];
  readonly issues = new Map<string, Issue>();
  /** Errors thrown by the next openPullRequest calls, in order. */
  readonly prFailures: Error[] = [];

  async openPullRequest(pr: FakeCodeHost["prs"][number]) {
    const failure = this.prFailures.shift();
    if (failure) throw failure;
    this.prs.push(pr);
    return { number: this.prs.length, url: `https://example.test/${pr.repo}/pull/${this.prs.length}` };
  }

  async getIssue(repo: string, number: number): Promise<Issue> {
    const issue = this.issues.get(`${repo}#${number}`);
    if (!issue) throw new Error(`no issue ${repo}#${number}`);
    return issue;
  }

  async comment(repo: string, number: number, body: string) {
    this.comments.push({ repo, number, body });
  }

  async getPullRequest(repo: string, number: number): Promise<PullRequestInfo> {
    const pr = this.prs[number - 1];
    if (!pr) throw new Error(`no PR ${repo}#${number}`);
    const sha = this.origin ? (await sh(`git rev-parse refs/heads/${pr.head}`, this.origin)).stdout.trim() : "0".repeat(40);
    return { number, state: this.prStates.get(number) ?? "open", url: `https://example.test/${repo}/pull/${number}`, head: { ref: pr.head, sha } };
  }

  async listReviews(_repo: string, number: number): Promise<Review[]> {
    return this.reviews.get(number) ?? [];
  }

  async reviewComments(_repo: string, _number: number, reviewId: number): Promise<ReviewComment[]> {
    return this.reviewCommentsById.get(reviewId) ?? [];
  }
}

/** A bare origin repo whose test command passes only once app.txt says "fixed". */
export async function makeOrigin(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shira-origin-"));
  const run = async (cmd: string, cwd = root) => {
    const r = await sh(cmd, cwd);
    if (r.code !== 0) throw new Error(`${cmd}: ${r.stderr}`);
  };
  await run("git init --quiet --bare -b main origin.git");
  await run("git clone --quiet origin.git seed");
  const seed = join(root, "seed");
  await run("git config user.name seed && git config user.email seed@localhost", seed);
  await run("echo broken > app.txt && git add app.txt && git commit --quiet -m init && git push --quiet origin HEAD:main", seed);
  return join(root, "origin.git");
}

/** Lists branches on the origin. */
export async function originBranches(origin: string): Promise<string[]> {
  const r = await sh("git for-each-ref --format='%(refname:short)' refs/heads", origin);
  return r.stdout.split("\n").filter(Boolean);
}
