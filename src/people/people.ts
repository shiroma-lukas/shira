import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import type { z } from "zod";
import type { ConfigError } from "../config/load.js";
import {
  ApprovalsFile,
  IdentitiesFile,
  OwnershipFile,
  RISK_ORDER,
  type ApprovalRequest,
  type ApprovalRule,
  type Identity,
  type OwnershipEntry,
} from "../contracts/people.js";
import type { Db } from "../db/client.js";
import type { SqlClient } from "../db/migrate.js";
import { globMatcher } from "../security/untrusted.js";

export type Authorization =
  | { allowed: true; identity: Identity; rule: number }
  | { allowed: false; identity: Identity | null; reason: string };

/**
 * Who is who and who may approve what (FR-H2), from the context repo's
 * `identities.yaml`, `approvals.yaml`, and `ownership.yaml`.
 */
export class People {
  private readonly byId: Map<string, Identity>;

  constructor(
    readonly identities: readonly Identity[],
    readonly rules: readonly ApprovalRule[],
    readonly owners: readonly OwnershipEntry[],
  ) {
    this.byId = new Map(identities.map((i) => [i.id, i]));
  }

  get(id: string): Identity | null {
    return this.byId.get(id) ?? null;
  }

  /** The identity behind a chat or GitHub account, or null for someone the context repo doesn't know. */
  find(account: { github: string } | { slack: string }): Identity | null {
    if ("github" in account) {
      const login = account.github.toLowerCase();
      return this.identities.find((i) => i.github?.toLowerCase() === login) ?? null;
    }
    return this.identities.find((i) => i.slack === account.slack) ?? null;
  }

  /**
   * Whether `identityId` may approve `req`. The platform acts on an approval only when
   * this allows it; anything else is recorded and ignored.
   */
  authorize(identityId: string | null, req: ApprovalRequest): Authorization {
    const identity = identityId ? this.get(identityId) : null;
    if (!identity) return { allowed: false, identity: null, reason: "not a known identity" };
    const rule = this.rules.findIndex(
      (r) =>
        (r.approvers.includes(identity.id) || r.approver_roles.some((role) => identity.roles.includes(role))) &&
        r.repos.some((g) => globMatcher(g)(req.repo)) &&
        RISK_ORDER[req.risk] <= RISK_ORDER[r.max_risk] &&
        req.estimatedUsd <= r.max_estimated_usd,
    );
    if (rule === -1) {
      return {
        allowed: false,
        identity,
        reason: `no approval rule lets ${identity.id} approve ${req.risk}-risk work on ${req.repo} estimated at $${req.estimatedUsd}`,
      };
    }
    return { allowed: true, identity, rule };
  }

  /** Identities allowed to approve `req`: whom to ask. */
  approversFor(req: ApprovalRequest): Identity[] {
    return this.identities.filter((i) => this.authorize(i.id, req).allowed);
  }
}

async function readYaml<S extends z.ZodType>(file: string, schema: S, errors: ConfigError[], fallback: z.infer<S>): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = parse(await readFile(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    errors.push({ file, message: `invalid YAML: ${(err as Error).message}` });
    return fallback;
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  for (const issue of parsed.error.issues) errors.push({ file, message: `${issue.path.join(".") || "(root)"}: ${issue.message}` });
  return fallback;
}

/**
 * Loads and cross-checks the people files from a context repo checkout. Missing files
 * mean nobody is known and nothing is approvable, which is valid (M1 installs).
 */
export async function loadPeople(contextDir: string): Promise<{ ok: true; people: People } | { ok: false; errors: ConfigError[] }> {
  const errors: ConfigError[] = [];
  const idFile = join(contextDir, "identities.yaml");
  const apFile = join(contextDir, "approvals.yaml");
  const ownFile = join(contextDir, "ownership.yaml");
  const { identities } = await readYaml(idFile, IdentitiesFile, errors, { identities: [] });
  const { rules } = await readYaml(apFile, ApprovalsFile, errors, { rules: [] });
  const { owners } = await readYaml(ownFile, OwnershipFile, errors, { owners: [] });

  const unique = (key: (i: Identity) => string | undefined, what: string) => {
    const seen = new Set<string>();
    for (const i of identities) {
      const k = key(i)?.toLowerCase();
      if (!k) continue;
      if (seen.has(k)) errors.push({ file: idFile, message: `duplicate ${what} "${key(i)}"` });
      seen.add(k);
    }
  };
  unique((i) => i.id, "identity id");
  unique((i) => i.github, "github login");
  unique((i) => i.slack, "slack id");

  const ids = new Set(identities.map((i) => i.id));
  const roles = new Set(identities.flatMap((i) => i.roles));
  rules.forEach((r, n) => {
    for (const a of r.approvers) if (!ids.has(a)) errors.push({ file: apFile, message: `rules.${n}.approvers: unknown identity "${a}"` });
    for (const role of r.approver_roles) {
      if (!roles.has(role)) errors.push({ file: apFile, message: `rules.${n}.approver_roles: no identity has role "${role}"` });
    }
  });
  owners.forEach((o, n) => {
    if (!ids.has(o.identity)) errors.push({ file: ownFile, message: `owners.${n}.identity: unknown identity "${o.identity}"` });
  });

  if (errors.length) return { ok: false, errors };
  return { ok: true, people: new People(identities, rules, owners) };
}

/**
 * Mirrors identities into the `identities` table, which decision records reference.
 * Rows are upserted, never deleted: past decisions keep their approver, and authority
 * comes from the files, so someone removed from them can't approve anything.
 */
export async function syncIdentities(db: Db, people: People): Promise<void> {
  await db.transaction(async (tx) => {
    for (const i of people.identities) await upsertIdentity(tx, i);
  });
}

async function upsertIdentity(db: SqlClient, i: Identity): Promise<void> {
  // A login or Slack id that moved to another identity: free it first (both are unique).
  await db.query("UPDATE identities SET chat_id = NULL WHERE chat_id = $1 AND id <> $2", [i.slack ?? null, i.id]);
  await db.query("UPDATE identities SET github_login = NULL WHERE github_login = $1 AND id <> $2", [i.github ?? null, i.id]);
  await db.query(
    `INSERT INTO identities (id, display_name, chat_id, github_login, approval_roles) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, chat_id = EXCLUDED.chat_id,
       github_login = EXCLUDED.github_login, approval_roles = EXCLUDED.approval_roles`,
    [i.id, i.name, i.slack ?? null, i.github ?? null, i.roles],
  );
}
