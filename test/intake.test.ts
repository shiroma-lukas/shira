import { describe, expect, it } from "vitest";
import { loadConfig, type LoadedConfig } from "../src/config/load.js";
import { submit } from "../src/queue/intake.js";
import { TaskStore } from "../src/queue/store.js";
import { testDb } from "./helpers.js";

async function checkedInConfig(): Promise<LoadedConfig> {
  const result = await loadConfig(new URL("../config", import.meta.url).pathname);
  if (!result.ok) throw new Error("checked-in config is invalid");
  return result.config;
}

describe("submit", () => {
  it("routes a CLI request to a worker with the worker's budget and logs the routing", async () => {
    const db = await testDb();
    const config = await checkedInConfig();
    const task = await submit(db, config, {
      source: "cli",
      requester: "cli:test",
      repo: "example-org/example-repo",
      goal: "fix CSV export",
    });
    expect(task.role).toBe("worker");
    expect(task.budget).toEqual(config.agents.find((a) => a.role === "worker")!.budget);
    expect(task.scope.paths).toEqual(["**"]);
    const routing = (await new TaskStore(db).events(task.id)).find((e) => e.kind === "routing");
    expect(routing?.payload).toMatchObject({ rule: "cli-to-worker", role: "worker" });
  });

  it("refuses repos without onboarding config", async () => {
    const db = await testDb();
    await expect(
      submit(db, await checkedInConfig(), { source: "cli", requester: "a", repo: "o/unknown", goal: "x" }),
    ).rejects.toThrow(/no onboarding config/);
  });

  it("escalates requests no rule covers", async () => {
    const db = await testDb();
    await expect(
      submit(db, await checkedInConfig(), { source: "slack", requester: "a", repo: "example-org/example-repo", goal: "x" }),
    ).rejects.toThrow(/no routing rule/);
  });
});
