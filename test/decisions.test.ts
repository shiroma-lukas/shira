import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import type { LoadedConfig } from "../src/config/load.js";
import { AgentDefinition, RepoConfig } from "../src/contracts/index.js";
import type { Db } from "../src/db/client.js";
import { getDecision, proposeDecision, recordDecision, type ContextChanges, type NewDecision } from "../src/decisions/decisions.js";
import { Dispatcher } from "../src/dispatcher/dispatcher.js";
import { People, syncIdentities } from "../src/people/people.js";
import { submit } from "../src/queue/intake.js";
import { LocalSandboxProvider } from "../src/sandbox/local.js";
import { FakeCodeHost, makeOrigin, ScriptedAdapter, type Step } from "./fakes.js";
import { testDb } from "./helpers.js";

const people = new People(
  [
    { id: "ana", name: "Ana", roles: ["tech-lead"] },
    { id: "bo", name: "Bo", roles: [] },
  ],
  [{ approvers: [], approver_roles: ["tech-lead"], repos: ["o/*"], max_risk: "medium", max_estimated_usd: 20 }],
  [],
);

const decision: NewDecision = {
  title: "Strip accents in slugs",
  what: "Slugs drop diacritics instead of keeping them.",
  why: "Links with accents break in some clients.",
  approver: "ana",
  repo: "o/r",
  risk: "low",
  estimatedUsd: 2,
  links: ["https://example.test/thread/1"],
};

/** Records proposed changes; fails the next calls when told to. */
class FakeContext implements ContextChanges {
  readonly proposed: Parameters<ContextChanges["proposeChange"]>[0][] = [];
  failures = 0;
  async proposeChange(change: Parameters<ContextChanges["proposeChange"]>[0]) {
    if (this.failures-- > 0) throw new Error("GitHub is down");
    this.proposed.push(change);
    return { number: 7, url: "https://example.test/o/context/pull/7" };
  }
}

describe("decision records (FR-C2, FR-C4)", () => {
  let db: Db;
  let context: FakeContext;
  const repo = { repo: "o/context", base: "main" };
  const now = () => new Date("2026-10-21T12:00:00Z");

  beforeEach(async () => {
    db = await testDb();
    await syncIdentities(db, people);
    context = new FakeContext();
  });

  it("records only approvals the matrix allows", async () => {
    await expect(recordDecision({ db, people }, { ...decision, approver: "bo" })).rejects.toThrow(/bo can't approve this: no approval rule/);
    await expect(recordDecision({ db, people }, { ...decision, risk: "high" })).rejects.toThrow(/can't approve/);
    await expect(recordDecision({ db, people }, { ...decision, approver: "zed" })).rejects.toThrow(/not a known identity/);
    expect((await db.query("SELECT count(*)::int AS n FROM decisions")).rows[0]).toEqual({ n: 0 });
  });

  it("numbers records, renders them, and proposes each to the context repo as a PR", async () => {
    const first = await recordDecision({ db, people, context: { changes: context, repo }, now }, decision);
    const second = await recordDecision({ db, people, context: { changes: context, repo }, now }, { ...decision, title: "Use UTC dates!" });

    expect(first.decision).toMatchObject({ id: "D-0001", recordRef: "decisions/D-0001-strip-accents-in-slugs.md", approver: "ana" });
    expect(second.decision.id).toBe("D-0002");
    expect(second.decision.recordRef).toBe("decisions/D-0002-use-utc-dates.md");
    expect(first.decision.body).toBe(
      [
        "---",
        "id: D-0001",
        "approver: ana",
        "date: 2026-10-21",
        "repo: o/r",
        "risk: low",
        "estimated_usd: 2",
        'links: ["https://example.test/thread/1"]',
        "---",
        "",
        "# Strip accents in slugs",
        "",
        "**What:** Slugs drop diacritics instead of keeping them.",
        "",
        "**Why:** Links with accents break in some clients.",
        "",
      ].join("\n"),
    );
    expect(context.proposed[0]).toMatchObject({
      repo: "o/context",
      base: "main",
      branch: "shira/decision-d-0001",
      files: [{ path: "decisions/D-0001-strip-accents-in-slugs.md", content: first.decision.body }],
      title: "D-0001: Strip accents in slugs",
    });
    expect((await getDecision(db, "D-0001"))!.meta.context_pr).toBe("https://example.test/o/context/pull/7");
  });

  it("keeps the decision when the PR can't be opened, and proposes it again later", async () => {
    context.failures = 1;
    const r = await recordDecision({ db, people, context: { changes: context, repo } }, decision);
    expect(r).toMatchObject({ contextPr: null, contextError: "GitHub is down" });
    expect((await getDecision(db, "D-0001"))!.meta.context_pr).toBeUndefined();

    await proposeDecision({ db, changes: context, repo }, (await getDecision(db, "D-0001"))!);
    expect((await getDecision(db, "D-0001"))!.meta.context_pr).toBe("https://example.test/o/context/pull/7");
  });
});

const config: LoadedConfig = {
  agents: [
    AgentDefinition.parse({
      apiVersion: "shira/v1",
      kind: "Agent",
      role: "worker",
      description: "test",
      model: { primary: { harness: "fake", model: "fake-model" } },
      permissions: ["read", "branch", "open_pr"],
      budget: { usd: 5, tokens: 1_000_000, minutes: 10, retries: 1 },
      instructions: "roles/worker.md",
    }),
  ],
  repos: [
    RepoConfig.parse({ apiVersion: "shira/v1", kind: "Repo", repo: "o/r", image: "none", test: "grep -q fixed app.txt" }),
    RepoConfig.parse({ apiVersion: "shira/v1", kind: "Repo", repo: "o/other", image: "none", test: "true" }),
  ],
};

describe("tasks that implement a decision", () => {
  let db: Db;

  beforeEach(async () => {
    db = await testDb();
    await syncIdentities(db, people);
    await recordDecision({ db, people }, decision);
  });

  it("must name an existing decision that covers the repo", async () => {
    const base = { source: "cli" as const, requester: "cli:t", goal: "Implement it" };
    await expect(submit(db, config, { ...base, repo: "o/r", decisionId: "D-0099" })).rejects.toThrow(/D-0099 not found/);
    await expect(submit(db, config, { ...base, repo: "o/other", decisionId: "D-0001" })).rejects.toThrow(/approved for o\/r, not o\/other/);
    expect((await submit(db, config, { ...base, repo: "o/r", decisionId: "D-0001" })).decisionId).toBe("D-0001");
  });

  it("hands the agent the record and says so in the PR", async () => {
    const origin = await makeOrigin();
    const host = new FakeCodeHost();
    await submit(db, config, { source: "cli", requester: "cli:t", repo: "o/r", goal: "Implement D-0001", decisionId: "D-0001" });
    let attached: { untrusted?: boolean; text: string } | undefined;
    const work: Step = async (input) => {
      const a = input.attachments!.find((x) => x.ref.kind === "decision")!;
      attached = { untrusted: a.untrusted, text: await readFile(a.path, "utf8") };
      expect(input.envelope.refs).toContainEqual({ kind: "decision", id: "D-0001" });
      await input.exec("echo fixed > app.txt && git commit --quiet -am fix");
      return { status: "done", summary: "Done.", artifact: { kind: "commit", repo: "o/r", branch: "x", sha: await input.exec("git rev-parse HEAD") } };
    };
    const d = new Dispatcher({
      db,
      config,
      adapters: new Map([["fake", new ScriptedAdapter([work])]]),
      sandboxes: new LocalSandboxProvider({ unsafeNoIsolation: true, cloneUrl: () => origin }),
      codeHost: host,
      instructions: async () => "be a worker",
      owner: "test",
      log: () => {},
    });
    expect(await d.tick()).toMatchObject({ status: "done" });
    expect(attached!.untrusted).toBeUndefined();
    expect(attached!.text).toContain("# Strip accents in slugs");
    expect(host.prs[0]!.body).toContain("Implements D-0001.");
  });
});
