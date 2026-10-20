import type { Ref } from "../contracts/index.js";
import type { LoadedConfig } from "../config/load.js";
import type { Db } from "../db/client.js";
import { route, type IntakeRequest } from "./router.js";
import { TaskStore, type Task } from "./store.js";

export interface SubmitRequest extends IntakeRequest {
  requester: string;
  repo: string;
  goal: string;
  /** Defaults to the whole repo. */
  paths?: string[];
  priority?: number;
  threadRef?: Ref;
  contextRefs?: Ref[];
}

/**
 * Normalizes a request into a queued task (FR-Q1): routes it, applies the role's
 * budget, checks the repo is onboarded, and logs the routing decision.
 */
export async function submit(db: Db, config: LoadedConfig, req: SubmitRequest): Promise<Task> {
  const r = route(req);
  if (!r) throw new Error(`no routing rule for ${req.source} requests; escalate to a human`);

  const agent = config.agents.find((a) => a.role === r.role);
  if (!agent) throw new Error(`no agent definition for role ${r.role}`);
  const repo = config.repos.find((c) => c.repo === req.repo);
  if (!repo) throw new Error(`repo ${req.repo} has no onboarding config`);

  // Config files are the source of truth for which repos exist; the table carries the kill flag per repo.
  await db.query(
    "INSERT INTO repos (repo, config_ref) VALUES ($1, $2) ON CONFLICT (repo) DO NOTHING",
    [repo.repo, `repos/${repo.repo}`],
  );

  const store = new TaskStore(db);
  const task = await store.create(
    {
      requester: req.requester,
      repo: req.repo,
      goal: req.goal,
      role: r.role,
      priority: req.priority ?? 0,
      budget: agent.budget,
      scope: { repo: req.repo, paths: req.paths?.length ? req.paths : ["**"] },
      contextRefs: req.contextRefs ?? [],
      threadRef: req.threadRef ?? null,
    },
    req.requester,
  );
  await store.record(task.id, "routing", "orchestrator", { rule: r.rule, role: r.role, source: req.source });
  return task;
}
