import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResumeInput, StartInput } from "../src/contracts/adapter.js";
import { Envelope, RepoConfig } from "../src/contracts/index.js";
import { ClaudeCodeAdapter } from "../src/harness/claude-code.js";
import { FileTranscriptStore } from "../src/harness/transcripts.js";
import { LocalSandboxProvider } from "../src/sandbox/local.js";
import type { Sandbox } from "../src/sandbox/sandbox.js";
import { makeOrigin } from "./fakes.js";

const binary = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const taskId = "7c1e2a4b-3f5d-4c8e-9a1b-2d3e4f5a6b7c";

describe("ClaudeCodeAdapter", () => {
  let sandbox: Sandbox;
  let argsFile: string;
  let adapter: ClaudeCodeAdapter;
  let input: StartInput;

  beforeEach(async () => {
    const origin = await makeOrigin();
    const repo = RepoConfig.parse({ apiVersion: "shira/v1", kind: "Repo", repo: "o/r", image: "none", test: "true" });
    sandbox = await new LocalSandboxProvider({ unsafeNoIsolation: true, cloneUrl: () => origin }).create({
      taskId,
      repo,
      branch: "shira/7c1e2a4b",
    });
    const scratch = await mkdtemp(join(tmpdir(), "shira-cc-"));
    argsFile = join(scratch, "args.jsonl");
    process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
    adapter = new ClaudeCodeAdapter({ transcripts: new FileTranscriptStore(join(scratch, "transcripts")), binary });
    input = {
      runId: "5d6e7f8a-9b1c-4d2e-a3f4-5a6b7c8d9e1f",
      envelope: Envelope.parse(JSON.parse(await readFile(new URL("../examples/handoff/01-envelope.json", import.meta.url), "utf8"))),
      workspace: sandbox.workspace,
      launch: sandbox.launch,
      model: "claude-sonnet-5-5",
      provider: "anthropic",
      instructions: "You are a worker.",
      tools: ["read", "edit", "shell"],
      remaining: { usd: 2.5 },
    };
  });

  afterEach(async () => {
    delete process.env.FAKE_CLAUDE_SCENARIO;
    await sandbox.destroy();
  });

  const run = async (scenario: string, i: StartInput = input, resume = false) => {
    process.env.FAKE_CLAUDE_SCENARIO = scenario;
    const session = resume ? await adapter.resume(i as ResumeInput) : await adapter.start(i);
    return adapter.result(session);
  };
  const lastArgs = async () => JSON.parse((await readFile(argsFile, "utf8")).trim().split("\n").at(-1)!) as string[];

  it("turns structured output into a done reply naming the HEAD commit", async () => {
    const outcome = await run("done");
    expect(outcome.kind).toBe("reply");
    if (outcome.kind !== "reply") return;
    const head = (await sandbox.exec("git rev-parse HEAD")).stdout.trim();
    expect(outcome.reply).toMatchObject({
      task_id: input.envelope.task_id,
      in_reply_to: input.envelope.id,
      from: "worker",
      status: "done",
      artifact: { kind: "commit", repo: input.envelope.scope.repo, branch: "shira/7c1e2a4b", sha: head },
    });
    expect(outcome.usage).toEqual({
      model: "claude-sonnet-5-5",
      inputTokens: 10,
      outputTokens: 50,
      cacheReadTokens: 1000,
      cacheWriteTokens: 200,
      usd: 0.42,
      durationMs: 1234,
    });
  });

  it("isolates the harness and enforces the remaining budget and tool allowlist", async () => {
    await run("done");
    const args = await lastArgs();
    for (const flag of ["--bare", "--strict-mcp-config", "--no-session-persistence"]) expect(args).toContain(flag);
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("2.50");
    expect(args[args.indexOf("--allowed-tools") + 1]).toBe("Read,Glob,Grep,Edit,Write,Bash");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("You are a worker.");
    expect(args[args.indexOf("-p") + 1]).toContain(input.envelope.goal);
  });

  it("rejects tool ids it cannot map", async () => {
    await expect(adapter.start({ ...input, tools: ["teleport"] })).rejects.toThrow(/no mapping for tool ids: teleport/);
  });

  it("returns needs_decision with the question", async () => {
    const outcome = await run("ask");
    expect(outcome.kind === "reply" && outcome.reply.question).toEqual({ kind: "technical", text: "A or B?", options: ["A", "B"], refs: [] });
  });

  it("briefs a resumed run with the question and the answer", async () => {
    const resume: ResumeInput = {
      ...input,
      checkpoint: {
        task_id: taskId,
        run_id: input.runId,
        harness: "claude-code",
        repo: "o/r",
        branch: "shira/7c1e2a4b",
        head_sha: "a".repeat(40),
        transcript_uri: "file:///t",
        session_ref: null,
        created_at: new Date().toISOString(),
      },
      question: { kind: "technical", text: "A or B?", options: ["A", "B"], refs: [] },
      answer: { v: 1, task_id: taskId, in_reply_to: input.envelope.id, answered_by: "tech-lead-1", text: "Go with A.", choice: 0 },
    };
    await run("done", resume, true);
    const prompt = (await lastArgs())[1]!;
    expect(prompt).toContain("You asked (technical): A or B?");
    expect(prompt).toContain("Chosen option: A");
    expect(prompt).toContain("Answer from tech-lead-1: Go with A.");
    expect(prompt).toContain("git log");
  });

  it("treats is_error as a failure even when subtype is success", async () => {
    const outcome = await run("auth_error");
    expect(outcome).toMatchObject({ kind: "aborted", reason: "error" });
    expect(outcome.kind === "aborted" && outcome.detail).toMatch(/Not logged in/);
  });

  it("passes the agent's title through", async () => {
    const outcome = await run("done");
    expect(outcome.kind === "reply" && outcome.reply.title).toBe("Make the app say fixed");
  });

  it("marks API rejections a retry can't fix as config_error, but not rate limits", async () => {
    expect(await run("workspace_error")).toMatchObject({ kind: "aborted", reason: "config_error" });
    expect(await run("rate_limited")).toMatchObject({ kind: "aborted", reason: "error" });
  });

  it("lists attachments with their local path in the prompt", async () => {
    const ref = { kind: "thread" as const, provider: "github" as const, id: "o/r#7" };
    await run("done", { ...input, envelope: { ...input.envelope, refs: [ref] }, attachments: [{ ref, path: "/workspace/refs/issue-7.md" }] });
    expect((await lastArgs())[1]).toContain('"id":"o/r#7"} (full text: /workspace/refs/issue-7.md)');
  });

  it("maps the budget stop to budget_exceeded", async () => {
    expect(await run("budget")).toMatchObject({ kind: "aborted", reason: "budget_exceeded" });
  });

  it("reports a crash without a result as an error", async () => {
    const outcome = await run("crash");
    expect(outcome).toMatchObject({ kind: "aborted", reason: "error" });
    expect(outcome.kind === "aborted" && outcome.detail).toMatch(/exited 3/);
  });

  it("stops a session on cancel", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "hang";
    const session = await adapter.start(input);
    setTimeout(() => adapter.cancel(session), 200);
    expect(await adapter.result(session)).toMatchObject({ kind: "aborted", reason: "cancelled" });
  });

  it("keeps the reply and usage when storing the transcript fails", async () => {
    const failing = new ClaudeCodeAdapter({
      transcripts: { write: async () => Promise.reject(new Error("AccessDenied")) },
      binary,
    });
    process.env.FAKE_CLAUDE_SCENARIO = "done";
    const outcome = await failing.result(await failing.start(input));
    expect(outcome.kind).toBe("reply");
    expect(outcome.usage.usd).toBe(0.42);
    expect(outcome.transcriptUri).toBe("unavailable: AccessDenied");
  });

  describe("through OpenRouter", () => {
    const glm = () => ({ ...input, model: "z-ai/glm-5.3-flash", provider: "openrouter" as const });

    it("leaves out --max-budget-usd, which Claude Code can't price for other models", async () => {
      await run("unknown_model", glm());
      const args = await lastArgs();
      expect(args).not.toContain("--max-budget-usd");
      expect(args[args.indexOf("--model") + 1]).toBe("z-ai/glm-5.3-flash");
    });

    it("prices the run from the price table and per-model token totals, ignoring Claude Code's guess", async () => {
      const priced = new ClaudeCodeAdapter({
        transcripts: new FileTranscriptStore(await mkdtemp(join(tmpdir(), "shira-cc-"))),
        binary,
        prices: (provider, model) =>
          provider === "openrouter" && model === "z-ai/glm-5.3-flash" ? { input: 1e-7, output: 2e-7, cacheRead: 1e-8 } : null,
      });
      process.env.FAKE_CLAUDE_SCENARIO = "unknown_model";
      const outcome = await priced.result(await priced.start(glm()));
      expect(outcome.kind).toBe("reply");
      expect(outcome.usage).toMatchObject({ inputTokens: 1_000_000, outputTokens: 200_000, cacheReadTokens: 500_000, cacheWriteTokens: 0 });
      expect(outcome.usage.usd).toBeCloseTo(0.1 + 0.04 + 0.005);
    });

    it("records the cost as unknown when the model has no price", async () => {
      const outcome = await run("unknown_model", glm());
      expect(outcome.usage.usd).toBeNull();
      expect(outcome.usage.inputTokens).toBe(1_000_000);
    });

    it("fails at once when OpenRouter is out of credits", async () => {
      expect(await run("no_credits", glm())).toMatchObject({ kind: "aborted", reason: "config_error" });
    });
  });

  it("records the cost as unknown when the run ends without a result", async () => {
    expect((await run("crash")).usage.usd).toBeNull();
  });

  it("stores a redacted transcript", async () => {
    const outcome = await run("done");
    const transcript = await readFile(fileURLToPath(outcome.transcriptUri), "utf8");
    expect(transcript).toContain('"type":"result"');
    expect(transcript).toContain("[REDACTED AWS access key id]");
    expect(transcript).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});
