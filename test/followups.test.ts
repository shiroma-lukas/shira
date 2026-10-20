import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import type { LoadedConfig } from "../src/config/load.js";
import { AgentDefinition, RepoConfig, type Budget } from "../src/contracts/index.js";
import type { Db } from "../src/db/client.js";
import { Dispatcher } from "../src/dispatcher/dispatcher.js";
import { prTitle } from "../src/dispatcher/pr.js";
import { GitHubError } from "../src/github/app.js";
import { submit } from "../src/queue/intake.js";
import { TaskStore, type Task } from "../src/queue/store.js";
import { LocalSandboxProvider } from "../src/sandbox/local.js";
import type { SandboxProvider } from "../src/sandbox/sandbox.js";
import { FakeCodeHost, makeOrigin, ScriptedAdapter, type Step } from "./fakes.js";
import { newTask, testDb } from "./helpers.js";

const budget: Budget = { usd: 5, tokens: 1_000_000, minutes: 10, retries: 2 };

const config: LoadedConfig = {
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
  repos: [RepoConfig.parse({ apiVersion: "shira/v1", kind: "Repo", repo: "o/r", image: "none", test: "grep -q fixed app.txt" })],
};

const fix =
  (title?: string): Step =>
  async ({ exec }) => {
    await exec("echo fixed > app.txt && git commit --quiet -am fix");
    const sha = await exec("git rev-parse HEAD");
    return { status: "done", summary: "Fixed app.txt.", ...(title ? { title } : {}), artifact: { kind: "commit", repo: "o/r", branch: "x", sha } };
  };

describe("follow-ups from the first end-to-end run", () => {
  let db: Db;
  let store: TaskStore;
  let host: FakeCodeHost;
  let origin: string;

  beforeEach(async () => {
    db = await testDb();
    store = new TaskStore(db);
    host = new FakeCodeHost();
    origin = await makeOrigin();
    host.issues.set("o/r#7", { number: 7, title: "App says broken", body: "It should say fixed.", state: "open", url: "https://example.test/o/r/issues/7" });
  });

  const dispatcher = (adapter: ScriptedAdapter, sandboxes?: SandboxProvider) =>
    new Dispatcher({
      db,
      config,
      adapters: new Map([["fake", adapter]]),
      sandboxes: sandboxes ?? new LocalSandboxProvider({ unsafeNoIsolation: true, cloneUrl: () => origin }),
      codeHost: host,
      issues: host,
      instructions: async () => "be a worker",
      owner: "test",
      log: () => {},
    });

  const lastReason = async (task: Task) => (await store.events(task.id)).at(-1)?.payload;

  describe("issue <-> PR linking", () => {
    it("turns an issue into a task and gives the agent its full text", async () => {
      const task = await submit(db, config, { source: "cli", requester: "cli:t", repo: "o/r", issue: 7 }, { issues: host });
      expect(task.goal).toBe("Resolve issue #7: App says broken");
      expect(task.threadRef).toEqual({ kind: "thread", provider: "github", id: "o/r#7" });

      let attached = "";
      const readIssue: Step = async (input) => {
        const a = input.attachments?.[0];
        expect(a?.ref).toEqual(task.threadRef);
        attached = await readFile(a!.path, "utf8");
        return fix("Make the app say fixed")(input);
      };
      expect(await dispatcher(new ScriptedAdapter([readIssue])).tick()).toMatchObject({ status: "done" });

      expect(attached).toContain("# App says broken");
      expect(attached).toContain("It should say fixed.");
      expect(host.prs[0]!.title).toBe("Make the app say fixed");
      expect(host.prs[0]!.body).toContain("Fixes #7");
      expect(host.comments).toEqual([{ repo: "o/r", number: 7, body: expect.stringMatching(/^Opened #1 to fix this/) }]);
    });

    it("refuses closed issues", async () => {
      host.issues.set("o/r#8", { number: 8, title: "Old", body: "", state: "closed", url: "" });
      await expect(submit(db, config, { source: "cli", requester: "t", repo: "o/r", issue: 8 }, { issues: host })).rejects.toThrow(/is closed/);
    });

    it("comments on the issue when the task fails", async () => {
      const task = await submit(db, config, { source: "cli", requester: "t", repo: "o/r", issue: 7 }, { issues: host });
      const giveUp: Step = async () => ({ status: "failed", summary: "Cannot reproduce." });
      expect(await dispatcher(new ScriptedAdapter([giveUp])).tick()).toMatchObject({ taskId: task.id, status: "failed" });
      expect(host.comments[0]!.body).toMatch(/couldn't complete this[\s\S]*agent reported failure/);
    });
  });

  describe("PR titles", () => {
    it("prefers the agent's title, else the goal's first sentence", () => {
      const task = { goal: "Fix the thing. It breaks on Tuesdays and also when it rains heavily outside." } as Task;
      expect(prTitle(task, "Handle rain in scheduler")).toBe("Handle rain in scheduler");
      expect(prTitle(task)).toBe("Fix the thing");
      expect(prTitle({ goal: "x".repeat(100) } as Task)).toHaveLength(72);
    });
  });

  describe("retry after the gate passed", () => {
    it("reopens the PR without running the agent again", async () => {
      const task = await store.create(newTask({ budget }), "cli:t");
      host.prFailures.push(new Error("socket hang up"));
      const adapter = new ScriptedAdapter([fix("Fix app")]); // one step only: a second agent run would throw

      expect(await dispatcher(adapter).tick()).toMatchObject({ status: "queued" });
      expect(await dispatcher(adapter).tick()).toMatchObject({ status: "done" });

      expect(adapter.calls).toHaveLength(1);
      expect(host.prs).toHaveLength(1);
      expect(host.prs[0]!.title).toBe("Fix app");
      const runs = await db.query("SELECT 1 FROM runs WHERE task_id = $1", [task.id]);
      expect(runs.rows).toHaveLength(1);
    });
  });

  describe("permanent errors fail at once", () => {
    it("on a GitHub permission error", async () => {
      const task = await store.create(newTask({ budget }), "cli:t");
      host.prFailures.push(new GitHubError("POST", "/repos/o/r/pulls", 422, "not all refs are readable"));
      expect(await dispatcher(new ScriptedAdapter([fix()])).tick()).toMatchObject({ status: "failed" });
      expect(await lastReason(task)).toMatchObject({ permanent: true, reason: expect.stringMatching(/422/) });
      expect((await store.get(task.id))!.retriesUsed).toBe(0);
    });

    it("on a harness configuration error", async () => {
      const task = await store.create(newTask({ budget }), "cli:t");
      const rejected: Step = async () => ({
        kind: "aborted",
        reason: "config_error",
        detail: "API Error: 400 This API key is not scoped to a workspace",
        transcriptUri: "file:///t",
        sessionRef: null,
        usage: { model: "m", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0, durationMs: 1 },
      });
      expect(await dispatcher(new ScriptedAdapter([rejected])).tick()).toMatchObject({ status: "failed" });
      expect(await lastReason(task)).toMatchObject({ permanent: true, reason: expect.stringMatching(/workspace/) });
    });

    it("on a repo the sandbox can't clone", async () => {
      const task = await store.create(newTask({ budget }), "cli:t");
      const broken: SandboxProvider = {
        create: async () => {
          throw new Error("sandbox setup failed: remote: Repository not found.");
        },
      };
      expect(await dispatcher(new ScriptedAdapter([]), broken).tick()).toMatchObject({ status: "failed" });
      expect(await lastReason(task)).toMatchObject({ permanent: true });
    });

    it("but still retries transient sandbox errors", async () => {
      await store.create(newTask({ budget }), "cli:t");
      const flaky: SandboxProvider = {
        create: async () => {
          throw new Error("Cannot connect to the Docker daemon");
        },
      };
      expect(await dispatcher(new ScriptedAdapter([]), flaky).tick()).toMatchObject({ status: "queued" });
    });
  });
});
