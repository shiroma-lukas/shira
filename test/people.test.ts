import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPeople, People, syncIdentities } from "../src/people/people.js";
import { testDb } from "./helpers.js";

/** A context repo checkout holding only the given files. */
async function context(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "shira-context-"));
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  return dir;
}

const IDENTITIES = `
identities:
  - { id: ana, name: Ana, github: Ana-Dev, slack: U0ANA, roles: [tech-lead] }
  - { id: bo, name: Bo, github: bo, roles: [product] }
  - { id: cy, name: Cy, slack: U0CY }
`;
const APPROVALS = `
rules:
  - { approver_roles: [tech-lead], repos: ["acme/*"], max_risk: high, max_estimated_usd: 50 }
  - { approvers: [bo], repos: [acme/web], max_risk: low, max_estimated_usd: 5 }
`;

async function people(): Promise<People> {
  const r = await loadPeople(await context({ "identities.yaml": IDENTITIES, "approvals.yaml": APPROVALS }));
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.people;
}

describe("loadPeople", () => {
  it("accepts the context template", async () => {
    const r = await loadPeople("context-template");
    expect(r.ok).toBe(true);
  });

  it("treats a context repo without people files as nobody known", async () => {
    const r = await loadPeople(await context({}));
    expect(r.ok && r.people.identities).toEqual([]);
    expect(r.ok && r.people.approversFor({ repo: "acme/web", risk: "low", estimatedUsd: 0 })).toEqual([]);
  });

  it("reports unknown and duplicate references", async () => {
    const r = await loadPeople(
      await context({
        "identities.yaml": `identities:\n  - { id: ana, name: A, github: ana }\n  - { id: ana2, name: B, github: ANA }\n  - { id: ana, name: C }`,
        "approvals.yaml": `rules:\n  - { approvers: [zed], approver_roles: [cto], repos: [acme/web], max_risk: low, max_estimated_usd: 1 }`,
        "ownership.yaml": `owners:\n  - { identity: ghost, repos: [acme/web], contact: { channel: slack } }`,
      }),
    );
    expect(r.ok).toBe(false);
    const messages = r.ok ? [] : r.errors.map((e) => e.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        'duplicate identity id "ana"',
        'duplicate github login "ANA"',
        'rules.0.approvers: unknown identity "zed"',
        'rules.0.approver_roles: no identity has role "cto"',
        'owners.0.identity: unknown identity "ghost"',
      ]),
    );
  });

  it("rejects a rule with no approvers", async () => {
    const r = await loadPeople(await context({ "approvals.yaml": `rules:\n  - { repos: [acme/web], max_risk: low, max_estimated_usd: 1 }` }));
    expect(!r.ok && r.errors[0]!.message).toMatch(/needs approvers or approver_roles/);
  });
});

describe("People", () => {
  it("finds identities by GitHub login (any case) or Slack id", async () => {
    const p = await people();
    expect(p.find({ github: "ana-dev" })?.id).toBe("ana");
    expect(p.find({ slack: "U0CY" })?.id).toBe("cy");
    expect(p.find({ github: "mallory" })).toBeNull();
  });

  it("authorizes by role or by name, within repo, risk, and cost limits", async () => {
    const p = await people();
    expect(p.authorize("ana", { repo: "acme/api", risk: "high", estimatedUsd: 50 })).toMatchObject({ allowed: true, rule: 0 });
    expect(p.authorize("ana", { repo: "acme/api", risk: "high", estimatedUsd: 51 }).allowed).toBe(false);
    expect(p.authorize("ana", { repo: "other/api", risk: "low", estimatedUsd: 1 }).allowed).toBe(false);
    expect(p.authorize("bo", { repo: "acme/web", risk: "low", estimatedUsd: 5 })).toMatchObject({ allowed: true, rule: 1 });
    expect(p.authorize("bo", { repo: "acme/web", risk: "medium", estimatedUsd: 1 })).toMatchObject({
      allowed: false,
      reason: "no approval rule lets bo approve medium-risk work on acme/web estimated at $1",
    });
    expect(p.authorize("bo", { repo: "acme/api", risk: "low", estimatedUsd: 1 }).allowed).toBe(false);
    expect(p.authorize("cy", { repo: "acme/web", risk: "low", estimatedUsd: 0 }).allowed).toBe(false);
    expect(p.authorize("zed", { repo: "acme/web", risk: "low", estimatedUsd: 0 })).toEqual({
      allowed: false,
      identity: null,
      reason: "not a known identity",
    });
    expect(p.authorize(null, { repo: "acme/web", risk: "low", estimatedUsd: 0 }).allowed).toBe(false);
  });

  it("lists whom to ask", async () => {
    const p = await people();
    expect(p.approversFor({ repo: "acme/web", risk: "low", estimatedUsd: 2 }).map((i) => i.id)).toEqual(["ana", "bo"]);
    expect(p.approversFor({ repo: "acme/web", risk: "medium", estimatedUsd: 2 }).map((i) => i.id)).toEqual(["ana"]);
  });
});

describe("syncIdentities", () => {
  it("mirrors identities into the table as the app role, following a login that moved", async () => {
    const db = await testDb();
    await syncIdentities(db, await people());
    const read = async () =>
      (await db.query("SELECT id, display_name, chat_id, github_login, approval_roles FROM identities ORDER BY id")).rows;
    expect(await read()).toEqual([
      { id: "ana", display_name: "Ana", chat_id: "U0ANA", github_login: "Ana-Dev", approval_roles: ["tech-lead"] },
      { id: "bo", display_name: "Bo", chat_id: null, github_login: "bo", approval_roles: ["product"] },
      { id: "cy", display_name: "Cy", chat_id: "U0CY", github_login: null, approval_roles: [] },
    ]);

    // bo leaves; cy takes over the "bo" GitHub login. bo's row stays for past decisions.
    const next = await loadPeople(
      await context({ "identities.yaml": `identities:\n  - { id: ana, name: Ana }\n  - { id: cy, name: Cy, github: bo }` }),
    );
    if (!next.ok) throw new Error("invalid");
    await syncIdentities(db, next.people);
    expect((await read()).map((r) => [r.id, r.github_login])).toEqual([
      ["ana", null],
      ["bo", null],
      ["cy", "bo"],
    ]);
    expect(next.people.authorize("bo", { repo: "acme/web", risk: "low", estimatedUsd: 0 }).allowed).toBe(false);
  });
});
