import type { LoadedConfig } from "../config/load.js";
import type { Scope } from "../contracts/index.js";
import type { Db } from "../db/client.js";
import type { People } from "../people/people.js";
import { TaskStore } from "../queue/store.js";
import type { PullRequests, Review } from "./pr.js";

/** Recorded on a follow-up task: which PR it updates and which reviews it answers. */
export interface ReviewFollowUp {
  type: "review_followup";
  pr: { repo: string; number: number };
  review_ids: number[];
  reviewers: string[];
}

/** GitHub roles that can already push to the repo: their reviews count even if the context repo doesn't list them. */
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const ACTIONABLE = new Set<Review["state"]>(["COMMENTED", "CHANGES_REQUESTED"]);
/** Only one dispatcher polls at a time; the lease outlives a poll, and lapses if its holder dies. */
const LEASE_KEY = "review_poll_lease";

interface WatchedPr {
  task_id: string;
  repo: string;
  number: number;
  scope: Scope;
}

/**
 * Turns review feedback on Shira's PRs into follow-up tasks for the worker (FR-H5, Flow D).
 * Polls through the GitHub App, so no public webhook endpoint is needed.
 *
 * - Watches PRs that Shira opened in the last 30 days until they close.
 * - Acts on submitted reviews that comment or request changes, from someone in the context
 *   repo's identities or with push access (owner, member, collaborator). Other reviews
 *   are recorded on the PR's task and ignored.
 * - Bundles every pending review on a PR into one follow-up task, and creates at most one
 *   unfinished follow-up per PR; reviews that arrive meanwhile go into the next one.
 * - The review text reaches the agent as untrusted input (the dispatcher attaches it).
 */
export class ReviewWatcher {
  private readonly store: TaskStore;

  constructor(
    private readonly deps: {
      db: Db;
      config: LoadedConfig;
      prs: PullRequests;
      people: People;
      owner: string;
      /** How long one poll may hold the lease. Default 5 minutes. */
      leaseMs?: number;
      log?: (message: string, fields?: Record<string, unknown>) => void;
    },
  ) {
    this.store = new TaskStore(deps.db);
  }

  /** One polling round. Returns the follow-up tasks it created. */
  async poll(): Promise<string[]> {
    if (!(await this.acquireLease())) return [];
    const created: string[] = [];
    for (const pr of await this.watched()) {
      try {
        const id = await this.check(pr);
        if (id) created.push(id);
      } catch (err) {
        this.deps.log?.("review poll failed", { repo: pr.repo, pr: pr.number, error: (err as Error).message });
      }
    }
    return created;
  }

  private async acquireLease(): Promise<boolean> {
    const until = new Date(Date.now() + (this.deps.leaseMs ?? 5 * 60_000)).toISOString();
    const { rows } = await this.deps.db.query(
      `INSERT INTO platform_settings (key, value, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
       WHERE (platform_settings.value->>'until')::timestamptz < now() OR platform_settings.value->>'owner' = $3
       RETURNING key`,
      [LEASE_KEY, JSON.stringify({ owner: this.deps.owner, until }), this.deps.owner],
    );
    return rows.length > 0;
  }

  /** Shira's PRs worth watching, each with the task that opened it. */
  private async watched(): Promise<WatchedPr[]> {
    const { rows } = await this.deps.db.query<WatchedPr>(
      `SELECT DISTINCT ON (t.repo, (e.payload->'pr'->>'number')::int)
              e.task_id, t.repo, (e.payload->'pr'->>'number')::int AS number, t.scope
       FROM task_events e JOIN tasks t ON t.id = e.task_id
       WHERE e.kind = 'state_change' AND e.to_status = 'done' AND e.payload ? 'pr'
         AND e.at > now() - interval '30 days'
         AND NOT EXISTS (
           SELECT 1 FROM task_events c
           WHERE c.kind = 'note' AND c.payload->>'type' = 'pr_closed'
             AND c.payload->'pr'->>'repo' = t.repo
             AND (c.payload->'pr'->>'number')::int = (e.payload->'pr'->>'number')::int)
       ORDER BY t.repo, (e.payload->'pr'->>'number')::int, e.id`,
    );
    return rows.filter((r) => this.deps.config.repos.some((c) => c.repo === r.repo));
  }

  /** Review ids already turned into a task or ignored, and whether a follow-up is still unfinished. */
  private async handled(pr: WatchedPr): Promise<{ seen: Set<number>; active: boolean }> {
    const { rows } = await this.deps.db.query<{ payload: { type: string; review_ids?: number[]; review_id?: number }; status: string }>(
      `SELECT e.payload, t.status FROM task_events e JOIN tasks t ON t.id = e.task_id
       WHERE e.kind = 'note' AND e.payload->>'type' IN ('review_followup', 'review_ignored')
         AND e.payload->'pr'->>'repo' = $1 AND (e.payload->'pr'->>'number')::int = $2`,
      [pr.repo, pr.number],
    );
    const seen = new Set<number>();
    let active = false;
    for (const { payload, status } of rows) {
      for (const id of payload.review_ids ?? []) seen.add(id);
      if (payload.review_id !== undefined) seen.add(payload.review_id);
      if (payload.type === "review_followup" && !["done", "failed", "cancelled"].includes(status)) active = true;
    }
    return { seen, active };
  }

  private async check(pr: WatchedPr): Promise<string | null> {
    const { seen, active } = await this.handled(pr);
    if (active) return null;

    const info = await this.deps.prs.getPullRequest(pr.repo, pr.number);
    const ref = { repo: pr.repo, number: pr.number };
    if (info.state !== "open") {
      await this.store.record(pr.task_id, "note", this.deps.owner, { type: "pr_closed", pr: ref });
      return null;
    }

    const fresh = (await this.deps.prs.listReviews(pr.repo, pr.number)).filter(
      (r) => !seen.has(r.id) && ACTIONABLE.has(r.state) && !r.author.endsWith("[bot]"),
    );
    const accepted: Review[] = [];
    for (const r of fresh) {
      const identity = this.deps.people.find({ github: r.author });
      if (identity || TRUSTED_ASSOCIATIONS.has(r.association)) {
        // An empty "comment" review with no inline comments has nothing to act on.
        if (r.body.trim() || (await this.deps.prs.reviewComments(pr.repo, pr.number, r.id)).length) accepted.push(r);
        continue;
      }
      // Recorded, not acted on (FR-H2): someone the context repo doesn't know, without push access.
      await this.store.record(pr.task_id, "note", this.deps.owner, {
        type: "review_ignored",
        pr: ref,
        review_id: r.id,
        reviewer: r.author,
        association: r.association,
        reason: "reviewer is not a known identity and has no push access",
      });
    }
    if (!accepted.length) return null;

    const agent = this.deps.config.agents.find((a) => a.role === "worker");
    if (!agent) throw new Error("no agent definition for role worker");
    const reviewers = [...new Set(accepted.map((r) => r.author))];
    const followUp: ReviewFollowUp = { type: "review_followup", pr: ref, review_ids: accepted.map((r) => r.id), reviewers };
    const task = await this.store.create(
      {
        requester: `github:${reviewers[0]}`,
        repo: pr.repo,
        // Logins are plain identifiers; the review text itself is attached as untrusted input.
        goal: `Address review feedback from ${reviewers.map((r) => `@${r}`).join(", ")} on PR #${pr.number} (attached)`,
        role: "worker",
        budget: agent.budget,
        scope: pr.scope,
        contextRefs: [{ kind: "pr", repo: pr.repo, number: pr.number }],
        parentId: pr.task_id,
      },
      this.deps.owner,
      [{ ...followUp }],
    );
    this.deps.log?.("review follow-up queued", { task: task.id, repo: pr.repo, pr: pr.number, reviews: followUp.review_ids });
    return task.id;
  }
}
