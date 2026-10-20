import { z } from "zod";
import {
  assertTransition,
  Budget,
  DecisionId,
  Ref,
  RepoName,
  Role,
  Scope,
  TaskId,
  TaskStatus,
  TERMINAL_STATUSES,
} from "../contracts/index.js";
import type { Db } from "../db/client.js";
import type { SqlClient } from "../db/migrate.js";
import { Settings } from "./settings.js";

export interface Task {
  id: string;
  parentId: string | null;
  requester: string;
  repo: string;
  goal: string;
  role: Role;
  status: TaskStatus;
  priority: number;
  budget: Budget;
  scope: Scope;
  contextRefs: Ref[];
  threadRef: Ref | null;
  decisionId: string | null;
  attempts: number;
  retriesUsed: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskEvent {
  id: number;
  taskId: string;
  at: Date;
  kind: "state_change" | "message" | "routing" | "approval" | "tool_action" | "note";
  actor: string;
  fromStatus: TaskStatus | null;
  toStatus: TaskStatus | null;
  payload: Record<string, unknown>;
}

export const NewTask = z
  .object({
    requester: z.string().min(1),
    repo: RepoName,
    goal: z.string().trim().min(1).max(500),
    role: Role,
    priority: z.number().int().default(0),
    budget: Budget,
    scope: Scope,
    contextRefs: z.array(Ref).default([]),
    threadRef: Ref.nullable().default(null),
    parentId: TaskId.nullable().default(null),
    decisionId: DecisionId.nullable().default(null),
    blockedBy: z.array(TaskId).default([]),
  })
  .refine((t) => t.scope.repo === t.repo, { path: ["scope", "repo"], message: "scope.repo must match repo" });
export type NewTask = z.input<typeof NewTask>;

/** Thrown when a task is not in the state the caller expected (another actor got there first). */
export class TaskConflictError extends Error {}

const TASK_COLUMNS = `id, parent_id, requester, repo, goal, role, status, priority, budget, scope,
  context_refs, thread_ref, decision_id, attempts, retries_used, lease_owner, lease_expires_at,
  created_at, updated_at`;

type Row = Record<string, unknown>;

function toTask(r: Row): Task {
  return {
    id: r.id as string,
    parentId: (r.parent_id as string | null) ?? null,
    requester: r.requester as string,
    repo: r.repo as string,
    goal: r.goal as string,
    role: r.role as Role,
    status: r.status as TaskStatus,
    priority: r.priority as number,
    budget: r.budget as Budget,
    scope: r.scope as Scope,
    contextRefs: r.context_refs as Ref[],
    threadRef: (r.thread_ref as Ref | null) ?? null,
    decisionId: (r.decision_id as string | null) ?? null,
    attempts: r.attempts as number,
    retriesUsed: r.retries_used as number,
    leaseOwner: (r.lease_owner as string | null) ?? null,
    leaseExpiresAt: (r.lease_expires_at as Date | null) ?? null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  };
}

function toEvent(r: Row): TaskEvent {
  return {
    id: Number(r.id),
    taskId: r.task_id as string,
    at: r.at as Date,
    kind: r.kind as TaskEvent["kind"],
    actor: r.actor as string,
    fromStatus: (r.from_status as TaskStatus | null) ?? null,
    toStatus: (r.to_status as TaskStatus | null) ?? null,
    payload: r.payload as Record<string, unknown>,
  };
}

async function appendEvent(
  db: SqlClient,
  taskId: string,
  kind: TaskEvent["kind"],
  actor: string,
  fields: { from?: TaskStatus | null; to?: TaskStatus | null; payload?: Record<string, unknown> } = {},
): Promise<void> {
  await db.query(
    `INSERT INTO task_events (task_id, kind, actor, from_status, to_status, payload)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [taskId, kind, actor, fields.from ?? null, fields.to ?? null, JSON.stringify(fields.payload ?? {})],
  );
}

export interface TransitionOptions {
  actor: string;
  /** Reject the change unless the task is currently in one of these states. */
  from?: TaskStatus | readonly TaskStatus[];
  payload?: Record<string, unknown>;
}

/**
 * Durable task queue on Postgres (FR-Q2). Every state change goes through
 * `transition`, which checks the lifecycle rules and writes the audit event in the
 * same transaction.
 */
export class TaskStore {
  constructor(private readonly db: Db) {}

  async create(input: NewTask, actor: string): Promise<Task> {
    const t = NewTask.parse(input);
    return this.db.transaction(async (tx) => {
      const repo = await tx.query<{ enabled: boolean }>("SELECT enabled FROM repos WHERE repo = $1", [t.repo]);
      if (!repo.rows[0]) throw new Error(`repo ${t.repo} is not onboarded`);
      if (!repo.rows[0].enabled) throw new Error(`repo ${t.repo} is disabled`);

      const { rows } = await tx.query<Row>(
        `INSERT INTO tasks (requester, repo, goal, role, priority, budget, scope, context_refs, thread_ref, parent_id, decision_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING ${TASK_COLUMNS}`,
        [
          t.requester,
          t.repo,
          t.goal,
          t.role,
          t.priority,
          JSON.stringify(t.budget),
          JSON.stringify(t.scope),
          JSON.stringify(t.contextRefs),
          t.threadRef && JSON.stringify(t.threadRef),
          t.parentId,
          t.decisionId,
        ],
      );
      const task = toTask(rows[0]!);
      for (const dep of t.blockedBy) {
        await tx.query("INSERT INTO task_dependencies (task_id, blocked_by_id) VALUES ($1, $2)", [task.id, dep]);
      }
      await appendEvent(tx, task.id, "state_change", actor, { to: "queued" });
      return task;
    });
  }

  async get(id: string): Promise<Task | null> {
    const { rows } = await this.db.query<Row>(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = $1`, [id]);
    return rows[0] ? toTask(rows[0]) : null;
  }

  async list(opts: { status?: TaskStatus; limit?: number } = {}): Promise<Task[]> {
    const { rows } = await this.db.query<Row>(
      `SELECT ${TASK_COLUMNS} FROM tasks
       WHERE ($1::text IS NULL OR status = $1)
       ORDER BY created_at DESC LIMIT $2`,
      [opts.status ?? null, opts.limit ?? 50],
    );
    return rows.map(toTask);
  }

  async events(taskId: string): Promise<TaskEvent[]> {
    const { rows } = await this.db.query<Row>("SELECT * FROM task_events WHERE task_id = $1 ORDER BY id", [taskId]);
    return rows.map(toEvent);
  }

  /** Records a non-state event (routing decision, message, note) in the audit log. */
  async record(taskId: string, kind: Exclude<TaskEvent["kind"], "state_change">, actor: string, payload: Record<string, unknown>) {
    await appendEvent(this.db, taskId, kind, actor, { payload });
  }

  async transition(id: string, to: TaskStatus, opts: TransitionOptions): Promise<Task> {
    return this.db.transaction((tx) => this.transitionIn(tx, id, to, opts));
  }

  private async transitionIn(
    tx: SqlClient,
    id: string,
    to: TaskStatus,
    opts: TransitionOptions & { countRetry?: boolean },
  ): Promise<Task> {
    const cur = await tx.query<{ status: TaskStatus }>("SELECT status FROM tasks WHERE id = $1 FOR UPDATE", [id]);
    const from = cur.rows[0]?.status;
    if (!from) throw new Error(`task ${id} not found`);
    const allowed = opts.from === undefined ? undefined : ([] as TaskStatus[]).concat(opts.from);
    if (allowed && !allowed.includes(from)) {
      throw new TaskConflictError(`task ${id} is ${from}, expected ${allowed.join(" or ")}`);
    }
    assertTransition(from, to);

    const { rows } = await tx.query<Row>(
      `UPDATE tasks SET
         status = $2,
         updated_at = now(),
         retries_used = retries_used + $3,
         lease_owner = CASE WHEN $2 = 'running' THEN lease_owner ELSE NULL END,
         lease_expires_at = CASE WHEN $2 = 'running' THEN lease_expires_at ELSE NULL END
       WHERE id = $1
       RETURNING ${TASK_COLUMNS}`,
      [id, to, opts.countRetry ? 1 : 0],
    );
    await appendEvent(tx, id, "state_change", opts.actor, { from, to, payload: opts.payload ?? {} });
    return toTask(rows[0]!);
  }

  /** Cancels a task that hasn't finished. A running task's worker notices on its next lease renewal. */
  async cancel(id: string, actor: string, reason?: string): Promise<Task> {
    const nonTerminal = TaskStatus.options.filter((s) => !TERMINAL_STATUSES.has(s));
    return this.transition(id, "cancelled", { actor, from: nonTerminal, payload: reason ? { reason } : {} });
  }

  /**
   * A running attempt failed (harness error, crash, lost lease). Requeues the task if
   * it has retries left, otherwise fails it (FR-O4).
   */
  async retryOrFail(id: string, actor: string, reason: string): Promise<Task> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ retries_used: number; budget: Budget }>(
        "SELECT retries_used, budget FROM tasks WHERE id = $1 FOR UPDATE",
        [id],
      );
      const t = rows[0];
      if (!t) throw new Error(`task ${id} not found`);
      const retry = t.retries_used < t.budget.retries;
      return this.transitionIn(tx, id, retry ? "queued" : "failed", {
        actor,
        from: "running",
        countRetry: retry,
        payload: { reason, retry: retry ? t.retries_used + 1 : null, retries_allowed: t.budget.retries },
      });
    });
  }

  /**
   * Claims the next runnable task for `owner` and leases it for `leaseMs`. Returns null
   * when the queue is empty or the kill switch is on. Safe to call from many
   * dispatchers at once: rows another dispatcher is claiming are skipped.
   */
  async claim(owner: string, leaseMs: number): Promise<Task | null> {
    return this.db.transaction(async (tx) => {
      if (await new Settings(tx).agentsPaused()) return null;
      const next = await tx.query<{ id: string }>(
        `SELECT id FROM tasks t
         WHERE status = 'queued'
           AND NOT EXISTS (
             SELECT 1 FROM task_dependencies d JOIN tasks b ON b.id = d.blocked_by_id
             WHERE d.task_id = t.id AND b.status <> 'done')
         ORDER BY priority DESC, created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
      );
      const id = next.rows[0]?.id;
      if (!id) return null;
      await this.transitionIn(tx, id, "running", { actor: owner, from: "queued" });
      const { rows } = await tx.query<Row>(
        `UPDATE tasks SET attempts = attempts + 1, lease_owner = $2,
           lease_expires_at = now() + ($3 * interval '1 millisecond')
         WHERE id = $1 RETURNING ${TASK_COLUMNS}`,
        [id, owner, leaseMs],
      );
      return toTask(rows[0]!);
    });
  }

  /** Extends a lease. False means the task was cancelled, reassigned, or is no longer running: stop work. */
  async renewLease(id: string, owner: string, leaseMs: number): Promise<boolean> {
    const { rows } = await this.db.query(
      `UPDATE tasks SET lease_expires_at = now() + ($3 * interval '1 millisecond')
       WHERE id = $1 AND lease_owner = $2 AND status = 'running'
       RETURNING id`,
      [id, owner, leaseMs],
    );
    return rows.length > 0;
  }

  /** Treats every expired lease as a failed attempt. Run periodically by any dispatcher. */
  async reapExpiredLeases(actor = "platform"): Promise<Task[]> {
    const { rows } = await this.db.query<{ id: string }>(
      "SELECT id FROM tasks WHERE status = 'running' AND lease_expires_at < now()",
    );
    const reaped: Task[] = [];
    for (const { id } of rows) {
      try {
        reaped.push(await this.retryOrFail(id, actor, "lease expired"));
      } catch (err) {
        // Another dispatcher reaped or finished it between the scan and the update.
        if (!(err instanceof TaskConflictError)) throw err;
      }
    }
    return reaped;
  }
}
