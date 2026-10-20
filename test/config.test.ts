import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { lintPermissions } from "../src/contracts/index.js";

const worker = (extra = "") => `apiVersion: atp/v1
kind: Agent
role: worker
description: test worker
model: { primary: { harness: claude-code, model: m } }
permissions: [read, branch, open_pr]
budget: { usd: 1, tokens: 1000, minutes: 5, retries: 0 }
instructions: roles/worker.md
${extra}`;

async function configDir(agents: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atp-config-"));
  await mkdir(join(root, "agents"));
  for (const [name, body] of Object.entries(agents)) await writeFile(join(root, "agents", name), body);
  return root;
}

describe("loadConfig", () => {
  it("accepts the checked-in config", async () => {
    const result = await loadConfig(new URL("../config", import.meta.url).pathname);
    expect(result.ok).toBe(true);
  });

  it("rejects merge permission", async () => {
    const root = await configDir({ "w.yaml": worker().replace("open_pr]", "open_pr, merge]") });
    const result = await loadConfig(root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.message).join()).toMatch(/merge is not grantable/);
  });

  it("rejects two definitions for one role", async () => {
    const root = await configDir({ "a.yaml": worker(), "b.yaml": worker() });
    const result = await loadConfig(root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.message).toMatch(/duplicate role "worker"/);
  });
});

describe("lintPermissions", () => {
  it("enforces the role ceiling", () => {
    expect(lintPermissions("reviewer", ["read", "open_pr"])).toContain("reviewer may not be granted open_pr");
  });

  it("enforces prerequisites", () => {
    expect(lintPermissions("worker", ["read", "open_pr"])).toContain("open_pr requires branch");
  });

  it("accepts a valid worker grant", () => {
    expect(lintPermissions("worker", ["read", "branch", "open_pr", "comment"])).toEqual([]);
  });
});
