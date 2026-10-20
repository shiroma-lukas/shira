import { randomUUID } from "node:crypto";
import type {
  HarnessAdapter,
  HarnessProcess,
  ResumeInput,
  RunOutcome,
  SessionHandle,
  StartInput,
} from "../contracts/adapter.js";
import type { Reply, Usage } from "../contracts/index.js";
import type { TranscriptStore } from "./transcripts.js";

/** Tool ids from agent definitions, mapped to Claude Code tool names. */
const TOOLS: Record<string, string[]> = {
  read: ["Read", "Glob", "Grep"],
  edit: ["Edit", "Write"],
  shell: ["Bash"],
  git: ["Bash(git *)"],
};

/** What the worker must return as structured output; the adapter turns it into a Reply. */
const REPLY_SCHEMA = {
  type: "object",
  properties: {
    status: { enum: ["done", "blocked", "needs_decision", "failed"] },
    summary: { type: "string", description: "At most three short lines." },
    title: { type: "string", description: "When done: a short imperative title for the change, under 72 characters." },
    question: {
      type: "object",
      description: "Required when status is needs_decision.",
      properties: {
        kind: { enum: ["technical", "business"] },
        text: { type: "string" },
        options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 6 },
      },
      required: ["kind", "text"],
    },
    blocked_by: { type: "array", items: { type: "string" }, description: "Task ids, when status is blocked." },
  },
  required: ["status", "summary"],
} as const;

interface StructuredReply {
  status: Reply["status"];
  summary: string;
  title?: string;
  question?: { kind: "technical" | "business"; text: string; options?: string[] };
  blocked_by?: string[];
}

/** The subset of Claude Code's stream-json `result` event the adapter reads. */
interface ResultEvent {
  type: "result";
  subtype: string;
  is_error: boolean;
  session_id: string;
  total_cost_usd?: number;
  duration_ms?: number;
  result?: string;
  api_error_status?: number | null;
  structured_output?: StructuredReply;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

interface Session {
  proc: HarnessProcess;
  input: StartInput;
  sessionId: string;
  cancelled: boolean;
  done: Promise<RunOutcome>;
}

/** A ref, plus where to read it when the platform attached a local copy. */
function refLine(ref: StartInput["envelope"]["refs"][number], input: StartInput): string {
  const copy = input.attachments?.find((a) => JSON.stringify(a.ref) === JSON.stringify(ref));
  return `- ${JSON.stringify(ref)}${copy ? ` (full text: ${copy.path})` : ""}`;
}

/**
 * API rejections a retry can't fix: bad request (e.g. a key outside any workspace,
 * an unknown model), bad or missing credentials, no permission. Rate limits (429) and
 * server errors (5xx) stay retryable.
 */
function isConfigError(result: ResultEvent): boolean {
  if (result.api_error_status) return [400, 401, 403, 404].includes(result.api_error_status);
  return /API Error: 40[0134]\b/.test(result.result ?? "");
}

function renderTask(input: StartInput): string {
  const e = input.envelope;
  return [
    `# Task ${e.task_id}`,
    "",
    `Goal: ${e.goal}`,
    "",
    `Repository: ${e.scope.repo}, branch ${input.workspace.branch}. Stay within: ${e.scope.paths.join(", ")}`,
    "",
    "Done when:",
    ...e.done_when.map((d) => `- ${d}`),
    ...(e.refs.length ? ["", "References (load only what you need):", ...e.refs.map((r) => refLine(r, input))] : []),
    "",
    "Commit your work on the current branch. Do not push and do not open a pull request;",
    "the platform rebases, tests, and opens it. When done, include a short imperative title",
    "for the change (it becomes the PR title). When finished, return the structured reply:",
    "done (work committed), needs_decision (one question for a human; commit work in",
    "progress first), blocked (waiting on other tasks), or failed (cannot be done).",
  ].join("\n");
}

function renderResume(input: ResumeInput): string {
  const lines = [
    renderTask(input),
    "",
    "# Resuming",
    "",
    "You already worked on this task in an earlier session. That work is committed on this",
    "branch: start with `git log` and `git diff` against the default branch to see it.",
  ];
  if (input.question) lines.push("", `You asked (${input.question.kind}): ${input.question.text}`);
  if (input.question?.options && input.answer?.choice !== undefined) {
    lines.push(`Chosen option: ${input.question.options[input.answer.choice] ?? input.answer.choice}`);
  }
  if (input.answer) lines.push(`Answer from ${input.answer.answered_by}: ${input.answer.text}`);
  if (input.answer?.decision_id) lines.push(`Recorded as decision ${input.answer.decision_id}.`);
  return lines.join("\n");
}

/**
 * Drives Claude Code in headless mode (`claude -p`) inside the task's sandbox (FR-X1).
 *
 * - Isolation from the sandbox host's Claude config: `--bare` skips hooks, plugins,
 *   and auto-memory and confines file tools to the workspace; `--strict-mcp-config`
 *   drops MCP servers. The target repo's CLAUDE.md is still read, which is wanted.
 * - Auth: `--bare` ignores interactive logins, so the sandbox must provide
 *   ANTHROPIC_API_KEY (or a gateway equivalent).
 * - Dollar budget: `--max-budget-usd` stops the run at the task's remaining budget.
 * - Resume is by replay. Claude Code keeps session files in the sandbox, which is
 *   destroyed on pause, so a resumed run is a new session briefed with the branch,
 *   the question, and the answer.
 */
export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly id = "claude-code";
  readonly capabilities = { nativeResume: false };
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly opts: {
      transcripts: TranscriptStore;
      binary?: string;
    },
  ) {}

  async start(input: StartInput): Promise<SessionHandle> {
    return this.begin(input, renderTask(input));
  }

  async resume(input: ResumeInput): Promise<SessionHandle> {
    return this.begin(input, renderResume(input));
  }

  async send(): Promise<void> {
    // Headless runs take a single prompt. Mid-run steering needs --input-format
    // stream-json; nothing uses it yet.
  }

  async cancel(handle: SessionHandle): Promise<void> {
    const s = this.sessions.get(handle.runId);
    if (!s) return;
    s.cancelled = true;
    s.proc.kill();
  }

  async result(handle: SessionHandle): Promise<RunOutcome> {
    const s = this.sessions.get(handle.runId);
    if (!s) throw new Error(`unknown session for run ${handle.runId}`);
    try {
      return await s.done;
    } finally {
      this.sessions.delete(handle.runId);
    }
  }

  private begin(input: StartInput, prompt: string): SessionHandle {
    const unknown = input.tools.filter((t) => !TOOLS[t]);
    if (unknown.length) throw new Error(`claude-code has no mapping for tool ids: ${unknown.join(", ")}`);
    const sessionId = randomUUID();
    const argv = [
      this.opts.binary ?? "claude",
      "-p",
      prompt,
      "--bare",
      "--strict-mcp-config",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      input.model,
      "--session-id",
      sessionId,
      "--no-session-persistence",
      "--permission-mode",
      "dontAsk",
      "--allowed-tools",
      input.tools.flatMap((t) => TOOLS[t]!).join(","),
      "--append-system-prompt",
      input.instructions,
      "--json-schema",
      JSON.stringify(REPLY_SCHEMA),
      "--max-budget-usd",
      Math.max(input.remaining.usd, 0).toFixed(2),
    ];
    const proc = input.launch(argv);
    const session: Session = { proc, input, sessionId, cancelled: false, done: undefined as never };
    session.done = this.collect(session);
    this.sessions.set(input.runId, session);
    return { harness: this.id, runId: input.runId, sessionRef: sessionId };
  }

  private async collect(s: Session): Promise<RunOutcome> {
    const started = Date.now();
    const lines: string[] = [];
    let result: ResultEvent | undefined;
    for await (const line of s.proc.lines) {
      if (!line.trim()) continue;
      lines.push(line);
      try {
        const event = JSON.parse(line) as { type?: string };
        if (event.type === "result") result = event as ResultEvent;
      } catch {
        // Non-JSON output (warnings) stays in the transcript only.
      }
    }
    const { code, stderr } = await s.proc.exited;
    if (stderr.trim()) lines.push(JSON.stringify({ type: "stderr", text: stderr }));
    const transcriptUri = await this.opts.transcripts.write(s.input.envelope.task_id, s.input.runId, lines);

    const usage: Usage = {
      model: s.input.model,
      inputTokens: result?.usage?.input_tokens ?? 0,
      outputTokens: result?.usage?.output_tokens ?? 0,
      cacheReadTokens: result?.usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: result?.usage?.cache_creation_input_tokens ?? 0,
      usd: result?.total_cost_usd ?? 0,
      durationMs: result?.duration_ms ?? Date.now() - started,
    };
    const base = { usage, transcriptUri, sessionRef: result?.session_id ?? s.sessionId };

    if (s.cancelled) return { ...base, kind: "aborted", reason: "cancelled" };
    if (!result) return { ...base, kind: "aborted", reason: "error", detail: `claude exited ${code} without a result: ${stderr.slice(-500)}` };
    if (result.subtype === "error_max_budget_usd") return { ...base, kind: "aborted", reason: "budget_exceeded" };
    // Claude Code can report subtype "success" with is_error true (e.g. auth failures).
    if (result.is_error || !result.structured_output) {
      const detail = `${result.subtype}: ${(result.result ?? "").slice(0, 500)}`;
      return { ...base, kind: "aborted", reason: isConfigError(result) ? "config_error" : "error", detail };
    }

    return { ...base, kind: "reply", reply: await this.toReply(s, result.structured_output) };
  }

  private async toReply(s: Session, out: StructuredReply): Promise<Reply> {
    const e = s.input.envelope;
    const reply: Reply = {
      v: 1,
      id: randomUUID(),
      task_id: e.task_id,
      in_reply_to: e.id,
      from: e.to,
      status: out.status,
      summary: out.summary,
      ...(out.title?.trim() ? { title: out.title.trim().slice(0, 100) } : {}),
      ...(out.status === "needs_decision" && out.question ? { question: { refs: [], ...out.question } } : {}),
      ...(out.status === "blocked" && out.blocked_by ? { blocked_by: out.blocked_by } : {}),
    };
    if (out.status === "done") {
      // The worker's artifact is whatever it committed; the dispatcher re-checks it against HEAD.
      const head = s.input.launch(["git", "rev-parse", "HEAD"]);
      let sha = "";
      for await (const l of head.lines) sha ||= l.trim();
      await head.exited;
      reply.artifact = { kind: "commit", repo: e.scope.repo, branch: s.input.workspace.branch, sha };
    }
    return reply;
  }
}
