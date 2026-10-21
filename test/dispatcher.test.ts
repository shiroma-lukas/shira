import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import type { LoadedConfig } from "../src/config/load.js";
import type { ResumeInput } from "../src/contracts/adapter.js";
import { AgentDefinition, RepoConfig, type Budget } from "../src/contracts/index.js";
import type { Db } from "../src/db/client.js";
import { Dispatcher } from "../src/dispatcher/dispatcher.js";
import { Ledger } from "../src/ledger/ledger.js";
import { CheckpointStore } from "../src/queue/checkpoints.js";
import { Settings } from "../src/queue/settings.js";
import { TaskStore } from "../src/queue/store.js";
import { ClaudeCodeAdapter } from "../src/harness/claude-code.js";
import { FileTranscriptStore } from "../src/harness/transcripts.js";
import { LocalSandboxProvider } from "../src/sandbox/local.js";
import { FakeCodeHost, makeOrigin, originBranches, ScriptedAdapter, type Step } from "./fakes.js";
import { newTask, testDb } from "./helpers.js";

const budget: Budget = { usd: 5, tokens: 1_000_000, minutes: 10, retries: 1 };

function config(): LoadedConfig {
  return {
    agents: [
      AgentDefinition.parse({
        apiVersion: "shira/v1",
        kind: "Agent",
        role: "worker",
        description: "test",
        model: { primary: { harness: "fake", model: "fake-model" } },
        permissions: ["read", "branch", "open_pr"],
        budget,
        instructions: "roles/worker.md",
      }),
    ],
    repos: [
      RepoConfig.parse({ apiVersion: "shira/v1", kind: "Repo", repo: "o/r", image: "none", test: "grep -q fixed app.txt" }),
    ],
  };
}

const fix: Step = async ({ exec }) => {
  await exec("echo fixed > app.txt && git commit --quiet -am fix");
  return { status: "done", summary: "Fixed app.txt.", artifact: { kind: "commit", repo: "o/r", branch: "x", sha: await exec("git rev-parse HEAD") } };
};

describe("Dispatcher", () => {
  let db: Db;
  let store: TaskStore;
  let origin: string;
  let host: FakeCodeHost;

  beforeEach(async () => {
    db = await testDb();
    store = new TaskStore(db);
    origin = await makeOrigin();
    host = new FakeCodeHost();
  });

  let revocations = 0;
  const dispatcher = (adapter: ScriptedAdapter | ClaudeCodeAdapter, leaseMs = 60_000) =>
    new Dispatcher({
      db,
      config: config(),
      adapters: new Map([["fake", adapter]]),
      sandboxes: new LocalSandboxProvider({ unsafeNoIsolation: true, cloneUrl: () => origin }),
      codeHost: host,
      credentials: { revokeTokens: async () => ++revocations },
      instructions: async () => "be a worker",
      owner: "dispatcher-test",
      leaseMs,
      killPollMs: 50,
      log: () => {},
    });

  describe("kill switch", () => {
    const settings = () => new Settings(db);
    const lastPayload = async (id: string) => (await store.events(id)).at(-1)?.payload;

    it("stops a running task and pauses it without using a retry", async () => {
      const task = await store.create(newTask({ budget }), "cli:test");
      const hang: Step = async ({ exec, cancelled }) => {
        await exec("echo half > app.txt && git commit --quiet -am wip");
        await settings().setAgentsPaused(true, "cli:test");
        await cancelled;
        return { status: "failed", summary: "unreachable" };
      };
      expect(await dispatcher(new ScriptedAdapter([hang])).tick()).toMatchObject({ status: "paused" });
      expect(await lastPayload(task.id)).toEqual({ reason: "kill switch", stage: "during the run" });
      expect((await store.get(task.id))!.retriesUsed).toBe(0);
      const runs = await db.query("SELECT outcome FROM runs WHERE task_id = $1", [task.id]);
      expect(runs.rows).toEqual([{ outcome: "cancelled" }]);
      expect(await originBranches(origin)).toEqual(["main"]);
      expect(host.prs).toHaveLength(0);
    });

    it("pushes nothing when the switch goes on as the agent finishes", async () => {
      const task = await store.create(newTask({ budget }), "cli:test");
      const finishThenKill: Step = async (input) => {
        const reply = await fix(input);
        await settings().setAgentsPaused(true, "cli:test");
        return reply;
      };
      expect(await dispatcher(new ScriptedAdapter([finishThenKill])).tick()).toMatchObject({ status: "paused" });
      expect(await lastPayload(task.id)).toEqual({ reason: "kill switch", stage: "before push" });
      expect(await originBranches(origin)).toEqual(["main"]);
    });

    it("claims nothing and revokes credentials once per kill; resume requeues", async () => {
      const task = await store.create(newTask({ budget }), "cli:test");
      await settings().setAgentsPaused(true, "cli:test");
      const d = dispatcher(new ScriptedAdapter([fix]));
      expect(await d.tick()).toEqual({ kind: "killed" });
      expect(await d.tick()).toEqual({ kind: "killed" });
      expect(revocations).toBe(1);
      expect((await store.get(task.id))!.status).toBe("queued");

      await settings().setAgentsPaused(false, "cli:test");
      expect(await d.tick()).toMatchObject({ status: "done" });
      await settings().setAgentsPaused(true, "cli:test");
      await d.tick();
      expect(revocations).toBe(2);
    });

    it("lists the tasks it paused, and resume runs them again", async () => {
      const task = await store.create(newTask({ budget }), "cli:test");
      const hang: Step = async ({ cancelled }) => {
        await settings().setAgentsPaused(true, "cli:test");
        await cancelled;
        return { status: "failed", summary: "unreachable" };
      };
      const d = dispatcher(new ScriptedAdapter([hang, fix]));
      await d.tick();
      expect((await store.pausedByKill()).map((t) => t.id)).toEqual([task.id]);

      await settings().setAgentsPaused(false, "cli:test");
      await store.transition(task.id, "queued", { actor: "cli:test", from: ["paused", "blocked"] }); // shira resume
      expect(await store.pausedByKill()).toEqual([]);
      expect(await d.tick()).toMatchObject({ taskId: task.id, status: "done" });
    });
  });

  it("takes a task from claim to an open PR", async () => {
    const task = await store.create(newTask({ budget }), "cli:test");
    const result = await dispatcher(new ScriptedAdapter([fix])).tick();

    expect(result).toEqual({ kind: "ran", taskId: task.id, status: "done" });
    expect(host.prs).toHaveLength(1);
    expect(host.prs[0]).toMatchObject({ repo: "o/r", head: `shira/${task.id.slice(0, 8)}`, base: "main", title: "fix the bug" });
    expect(host.prs[0]!.body).toContain("Fixed app.txt.");
    expect(host.prs[0]!.body).toContain("`grep -q fixed app.txt` passed");
    expect(host.prs[0]!.body).toMatch(/\$0\.10 of \$5 budget/);
    expect(await originBranches(origin)).toContain(`shira/${task.id.slice(0, 8)}`);
    expect((await new Ledger(db).taskSpend(task.id)).usd).toBeCloseTo(0.1);
    const done = (await store.events(task.id)).at(-1);
    expect(done?.payload).toMatchObject({ pr: { number: 1 } });
  });

  it("runs the Claude Code adapter end to end", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "done";
    const task = await store.create(newTask({ budget }), "cli:test");
    const adapter = new ClaudeCodeAdapter({
      transcripts: new FileTranscriptStore(await mkdtemp(join(tmpdir(), "shira-transcripts-"))),
      binary: fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url)),
    });
    try {
      expect(await dispatcher(adapter).tick()).toMatchObject({ status: "done" });
    } finally {
      delete process.env.FAKE_CLAUDE_SCENARIO;
    }
    expect(host.prs[0]?.body).toContain("Fixed app.txt.");
    const runs = await db.query<{ harness: string; usd: string; transcript_uri: string }>(
      "SELECT harness, usd, transcript_uri FROM runs WHERE task_id = $1",
      [task.id],
    );
    expect(runs.rows[0]).toMatchObject({ harness: "claude-code", usd: "0.420000" });
    expect(runs.rows[0]!.transcript_uri).toMatch(/^file:/);
  });

  it("checkpoints on needs_decision and resumes with the answer", async () => {
    const task = await store.create(newTask({ budget }), "cli:test");
    const ask: Step = async ({ exec }) => {
      await exec("echo half-done > notes.txt"); // left uncommitted on purpose
      return {
        status: "needs_decision",
        summary: "Need a choice.",
        question: { kind: "technical", text: "A or B?", options: ["A", "B"], refs: [] },
      };
    };
    const finish: Step = async (input) => {
      expect(await input.exec("cat notes.txt")).toBe("half-done");
      return fix(input);
    };
    const adapter = new ScriptedAdapter([ask, finish]);
    const d = dispatcher(adapter);

    expect(await d.tick()).toMatchObject({ status: "needs_decision" });
    const checkpoint = await new CheckpointStore(db).latest(task.id, "o/r");
    expect(checkpoint?.branch).toBe(`shira/${task.id.slice(0, 8)}`);
    expect(await d.tick()).toEqual({ kind: "idle" }); // nothing runs while waiting on a human

    const question = (await store.events(task.id)).find((e) => e.toStatus === "needs_decision")!;
    await store.answer({ v: 1, task_id: task.id, in_reply_to: question.payload.reply_id as string, answered_by: "tech-lead-1", text: "A", choice: 0 });

    expect(await d.tick()).toMatchObject({ status: "done" });
    const [first, second] = adapter.calls;
    expect(second?.kind).toBe("resume");
    expect((second!.input as ResumeInput).answer?.text).toBe("A");
    expect((second!.input as ResumeInput).checkpoint.head_sha).toBe(checkpoint?.head_sha);
    expect(second!.input.envelope.id).toBe(first!.input.envelope.id);
    expect(host.prs).toHaveLength(1);
  });

  it("retries when tests fail after rebase, then fails when retries run out", async () => {
    const task = await store.create(newTask({ budget }), "cli:test");
    const noFix: Step = async ({ exec }) => {
      await exec("echo still-broken > app.txt && git commit --quiet -am try");
      return { status: "done", summary: "Tried.", artifact: { kind: "commit", repo: "o/r", branch: "x", sha: await exec("git rev-parse HEAD") } };
    };
    const d = dispatcher(new ScriptedAdapter([noFix, noFix]));
    expect(await d.tick()).toMatchObject({ status: "queued" });
    expect(await d.tick()).toMatchObject({ status: "failed" });
    expect(host.prs).toHaveLength(0);
    const last = (await store.events(task.id)).at(-1);
    expect(last?.payload.reason).toMatch(/tests failed/);
  });

  it("fails without pushing when the diff contains a secret", async () => {
    const task = await store.create(newTask({ budget }), "cli:test");
    const leak: Step = async ({ exec }) => {
      await exec("printf 'fixed\\nkey=AKIAIOSFODNN7EXAMPLE\\n' > app.txt && git commit --quiet -am fix");
      return { status: "done", summary: "Fixed.", artifact: { kind: "commit", repo: "o/r", branch: "x", sha: await exec("git rev-parse HEAD") } };
    };
    expect(await dispatcher(new ScriptedAdapter([leak])).tick()).toMatchObject({ status: "failed" });
    expect(await originBranches(origin)).toEqual(["main"]);
    expect((await store.events(task.id)).at(-1)?.payload.reason).toBe("secret detected in diff");
  });

  it("retries a done reply whose artifact is not the branch HEAD", async () => {
    await store.create(newTask({ budget }), "cli:test");
    const lie: Step = async () => ({ status: "done", summary: "Done.", artifact: { kind: "commit", repo: "o/r", branch: "x", sha: "0".repeat(40) } });
    expect(await dispatcher(new ScriptedAdapter([lie])).tick()).toMatchObject({ status: "queued" });
  });

  it("stops the run when the task is cancelled", async () => {
    const task = await store.create(newTask({ budget }), "cli:test");
    const hang: Step = async ({ cancelled }) => {
      await store.cancel(task.id, "cli:test", "not needed");
      await cancelled;
      throw new Error("unreachable");
    };
    expect(await dispatcher(new ScriptedAdapter([hang]), 150).tick()).toMatchObject({ status: "cancelled" });
    const runs = await db.query<{ outcome: string }>("SELECT outcome FROM runs WHERE task_id = $1", [task.id]);
    expect(runs.rows).toEqual([{ outcome: "cancelled" }]);
  });

  it("fails a run that exceeds the time budget", async () => {
    const task = await store.create(newTask({ budget: { ...budget, minutes: 0.005 } }), "cli:test");
    const hang: Step = async ({ cancelled }) => {
      await cancelled;
      throw new Error("unreachable");
    };
    const r = await dispatcher(new ScriptedAdapter([hang])).tick();
    expect(r).toMatchObject({ status: "failed" });
    expect((await store.events(task.id)).at(-1)?.payload.reason).toBe("timeout");
  });

  it("runs tasks side by side with concurrency", async () => {
    for (let i = 0; i < 3; i++) await store.create(newTask({ budget, goal: `task ${i}` }), "cli:test");
    // Each step waits until all three are running at once, then fixes its repo.
    let running = 0;
    let peak = 0;
    const together: Step = async (input) => {
      running++;
      peak = Math.max(peak, running);
      const deadline = Date.now() + 10_000;
      while (peak < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      running--;
      return fix(input);
    };
    const stop = new AbortController();
    const d = dispatcher(new ScriptedAdapter([together, together, together]));
    const done = d.run(stop.signal, 20, 3);
    const deadline = Date.now() + 20_000;
    while ((await store.list({ status: "done" })).length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    stop.abort();
    await done;

    expect(peak).toBe(3);
    expect(await store.list({ status: "done" })).toHaveLength(3);
    expect(new Set(host.prs.map((p) => p.head)).size).toBe(3);
  }, 30_000);

  it("finishes in-flight tasks when stopped", async () => {
    await store.create(newTask({ budget }), "cli:test");
    const stop = new AbortController();
    const slow: Step = async (input) => {
      stop.abort(); // stop arrives while the task is running
      return fix(input);
    };
    await dispatcher(new ScriptedAdapter([slow])).run(stop.signal, 20, 2);
    expect(await store.list({ status: "done" })).toHaveLength(1);
  });

  it("starts nothing once the monthly budget is spent", async () => {
    const first = await store.create(newTask({ budget }), "cli:test");
    await dispatcher(new ScriptedAdapter([fix])).tick();
    await new Settings(db).setMonthlyBudgetUsd(0.05, "admin");
    await store.create(newTask({ budget }), "cli:test");
    expect(await dispatcher(new ScriptedAdapter([fix])).tick()).toMatchObject({ kind: "budget_exhausted" });
    expect((await store.get(first.id))?.status).toBe("done");
  });
});
