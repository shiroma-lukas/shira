import type { Ref } from "../contracts/index.js";
import type { Risk } from "../contracts/people.js";
import type { Db } from "../db/client.js";
import type { People } from "../people/people.js";

/** Opens a PR against the context repo (FR-C4). Production: the GitHub App. */
export interface ContextChanges {
  proposeChange(change: {
    repo: string;
    base: string;
    branch: string;
    files: { path: string; content: string }[];
    title: string;
    body: string;
  }): Promise<{ number: number; url: string }>;
}

export interface ContextRepoRef {
  /** org/name of the context repo on GitHub. */
  repo: string;
  /** Its main branch, which only humans merge into. */
  base: string;
}

export interface NewDecision {
  title: string;
  what: string;
  why: string;
  assumptions?: string;
  /** Identity id of the approver; must be allowed by the approval matrix. */
  approver: string;
  /** What the approval covers. */
  repo: string;
  risk: Risk;
  estimatedUsd: number;
  links?: string[];
  threadRef?: Ref | null;
}

export interface Decision {
  id: string;
  title: string;
  recordRef: string;
  approver: string;
  approvedAt: Date;
  body: string;
  meta: { repo?: string; risk?: Risk; estimated_usd?: number; links?: string[]; context_pr?: string };
}

/** Constant identifying the lock that serializes decision id allocation. */
const DECISION_ID_LOCK = 7_429_102;

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "decision";
}

/** The record as it lands in the context repo, following decisions/D-0000-template.md. */
export function renderDecision(id: string, d: NewDecision, date: Date): string {
  const links = d.links ?? [];
  return [
    "---",
    `id: ${id}`,
    `approver: ${d.approver}`,
    `date: ${date.toISOString().slice(0, 10)}`,
    `repo: ${d.repo}`,
    `risk: ${d.risk}`,
    `estimated_usd: ${d.estimatedUsd}`,
    `links: ${JSON.stringify(links)}`,
    "---",
    "",
    `# ${d.title}`,
    "",
    `**What:** ${d.what}`,
    "",
    `**Why:** ${d.why}`,
    ...(d.assumptions ? ["", `**Assumptions:** ${d.assumptions}`] : []),
    "",
  ].join("\n");
}

/**
 * Records an approved decision (FR-C2): checks the approver against the approval matrix
 * (FR-H2), allocates the next D-NNNN id, stores the record, and proposes it to the
 * context repo as a PR. Shira never writes to the context repo's main branch: a human
 * merges the PR. If the PR can't be opened the decision still stands (the approval
 * happened); `proposeDecision` retries it.
 */
export async function recordDecision(
  deps: { db: Db; people: People; context?: { changes: ContextChanges; repo: ContextRepoRef }; now?: () => Date },
  d: NewDecision,
): Promise<{ decision: Decision; contextPr: { url: string } | null; contextError: string | null }> {
  const auth = deps.people.authorize(d.approver, { repo: d.repo, risk: d.risk, estimatedUsd: d.estimatedUsd });
  if (!auth.allowed) throw new Error(`${d.approver} can't approve this: ${auth.reason}`);
  const approvedAt = deps.now?.() ?? new Date();

  const decision = await deps.db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [DECISION_ID_LOCK]);
    const { rows } = await tx.query<{ n: number | null }>("SELECT max(substring(id from 3)::int) AS n FROM decisions");
    const id = `D-${String((rows[0]?.n ?? 0) + 1).padStart(4, "0")}`;
    const recordRef = `decisions/${id}-${slug(d.title)}.md`;
    const body = renderDecision(id, d, approvedAt);
    const meta = { repo: d.repo, risk: d.risk, estimated_usd: d.estimatedUsd, links: d.links ?? [] };
    await tx.query(
      `INSERT INTO decisions (id, record_ref, approver_id, approved_at, thread_ref, title, body, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, recordRef, d.approver, approvedAt.toISOString(), d.threadRef ? JSON.stringify(d.threadRef) : null, d.title, body, JSON.stringify(meta)],
    );
    return { id, title: d.title, recordRef, approver: d.approver, approvedAt, body, meta } satisfies Decision;
  });

  if (!deps.context) return { decision, contextPr: null, contextError: "no context repo configured (SHIRA_CONTEXT_REPO)" };
  try {
    const pr = await proposeDecision({ db: deps.db, ...deps.context }, decision);
    return { decision: { ...decision, meta: { ...decision.meta, context_pr: pr.url } }, contextPr: pr, contextError: null };
  } catch (err) {
    return { decision, contextPr: null, contextError: (err as Error).message };
  }
}

/** Proposes a stored decision's record to the context repo, and remembers the PR. Safe to repeat. */
export async function proposeDecision(
  deps: { db: Db; changes: ContextChanges; repo: ContextRepoRef },
  decision: Decision,
): Promise<{ number: number; url: string }> {
  const pr = await deps.changes.proposeChange({
    repo: deps.repo.repo,
    base: deps.repo.base,
    branch: `shira/decision-${decision.id.toLowerCase()}`,
    files: [{ path: decision.recordRef, content: decision.body }],
    title: `${decision.id}: ${decision.title}`,
    body: [
      `Decision record ${decision.id}, approved by \`${decision.approver}\` on ${decision.approvedAt.toISOString().slice(0, 10)}.`,
      "",
      "Shira proposes records and other context changes as PRs; merging is a human decision (FR-C4).",
    ].join("\n"),
  });
  await deps.db.query("UPDATE decisions SET meta = meta || $2 WHERE id = $1", [decision.id, JSON.stringify({ context_pr: pr.url })]);
  return pr;
}

export async function getDecision(db: Db, id: string): Promise<Decision | null> {
  const { rows } = await db.query<{
    id: string;
    title: string | null;
    record_ref: string;
    approver_id: string;
    approved_at: Date | string;
    body: string | null;
    meta: Decision["meta"];
  }>("SELECT id, title, record_ref, approver_id, approved_at, body, meta FROM decisions WHERE id = $1", [id]);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    title: r.title ?? r.id,
    recordRef: r.record_ref,
    approver: r.approver_id,
    approvedAt: new Date(r.approved_at),
    body: r.body ?? "",
    meta: r.meta,
  };
}
