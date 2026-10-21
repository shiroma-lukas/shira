import type { Budget, Role } from "../contracts/index.js";
import type { RunOutcome } from "../contracts/adapter.js";
import type { SqlClient } from "../db/migrate.js";

export interface Spend {
  /** Known cost only. Runs with an unknown cost are counted in `unpricedRuns`, not as zero. */
  usd: number;
  unpricedRuns: number;
  /** All billed tokens: input, output, cache reads, and cache writes. */
  tokens: number;
  minutes: number;
}

export type BudgetDimension = "usd" | "tokens" | "minutes";

/** "$1.23", or "$1.23 + unknown (2 unpriced runs)" when some runs have no known cost. */
export function formatUsd(spend: Pick<Spend, "usd" | "unpricedRuns">): string {
  const known = `$${spend.usd.toFixed(2)}`;
  if (!spend.unpricedRuns) return known;
  return `${known} + unknown (${spend.unpricedRuns} unpriced run${spend.unpricedRuns === 1 ? "" : "s"})`;
}

/** Returns the first budget dimension that spend has reached, or null if within budget (FR-K2). */
export function exceededBudget(budget: Budget, spend: Pick<Spend, "usd" | "tokens" | "minutes">): BudgetDimension | null {
  if (spend.usd >= budget.usd) return "usd";
  if (spend.tokens >= budget.tokens) return "tokens";
  if (spend.minutes >= budget.minutes) return "minutes";
  return null;
}

/** The cost ledger: one row per harness run (FR-K1). */
export class Ledger {
  constructor(private readonly db: SqlClient) {}

  async startRun(r: { taskId: string; role: Role; harness: string; model: string }): Promise<{ id: string; attempt: number }> {
    const { rows } = await this.db.query<{ id: string; attempt: number }>(
      `INSERT INTO runs (task_id, attempt, role, harness, model)
       VALUES ($1, (SELECT coalesce(max(attempt), 0) + 1 FROM runs WHERE task_id = $1), $2, $3, $4)
       RETURNING id, attempt`,
      [r.taskId, r.role, r.harness, r.model],
    );
    return rows[0]!;
  }

  async finishRun(runId: string, outcome: RunOutcome): Promise<void> {
    const u = outcome.usage;
    await this.db.query(
      `UPDATE runs SET
         model = $2, input_tokens = $3, output_tokens = $4, cache_read_tokens = $5, cache_write_tokens = $6,
         usd = $7, duration_ms = $8, outcome = $9, transcript_uri = $10, ended_at = now()
       WHERE id = $1 AND ended_at IS NULL`,
      [
        runId,
        u.model,
        u.inputTokens,
        u.outputTokens,
        u.cacheReadTokens,
        u.cacheWriteTokens,
        u.usd,
        u.durationMs,
        outcome.kind === "reply" ? outcome.reply.status : outcome.reason,
        outcome.transcriptUri,
      ],
    );
  }

  /** Every run of a task, oldest first: what the PR and `shira show` link to (FR-L2). `usd` is null when unknown. */
  async runs(taskId: string): Promise<{ attempt: number; outcome: string | null; usd: number | null; transcriptUri: string | null }[]> {
    const { rows } = await this.db.query<{ attempt: number; outcome: string | null; usd: string | null; transcript_uri: string | null }>(
      "SELECT attempt, outcome, usd, transcript_uri FROM runs WHERE task_id = $1 ORDER BY attempt",
      [taskId],
    );
    return rows.map((r) => ({
      attempt: r.attempt,
      outcome: r.outcome,
      usd: r.usd === null ? null : Number(r.usd),
      transcriptUri: r.transcript_uri,
    }));
  }

  /** Total spend across every run of a task, including runs before a pause. */
  async taskSpend(taskId: string): Promise<Spend> {
    const { rows } = await this.db.query<{ usd: string; unpriced: string; tokens: string; ms: string }>(
      `SELECT coalesce(sum(usd), 0) AS usd,
              count(*) FILTER (WHERE usd IS NULL) AS unpriced,
              coalesce(sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens,
              coalesce(sum(duration_ms), 0) AS ms
       FROM runs WHERE task_id = $1`,
      [taskId],
    );
    const r = rows[0]!;
    return { usd: Number(r.usd), unpricedRuns: Number(r.unpriced), tokens: Number(r.tokens), minutes: Number(r.ms) / 60_000 };
  }

  /**
   * Spend since the start of the current calendar month (UTC), for the monthly ceiling.
   * It fails closed: a run with no known cost (unpriced, still running, or orphaned by a
   * dead dispatcher) counts at its task's whole dollar budget, the most it was allowed to spend.
   */
  async monthSpend(): Promise<{ usd: number; unpricedRuns: number }> {
    const { rows } = await this.db.query<{ usd: string; unpriced: string }>(
      `SELECT coalesce(sum(coalesce(r.usd, (t.budget->>'usd')::numeric)), 0) AS usd,
              count(*) FILTER (WHERE r.usd IS NULL) AS unpriced
       FROM runs r JOIN tasks t ON t.id = r.task_id
       WHERE r.started_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    );
    return { usd: Number(rows[0]!.usd), unpricedRuns: Number(rows[0]!.unpriced) };
  }
}
