import { Checkpoint } from "../contracts/index.js";
import type { SqlClient } from "../db/migrate.js";

/** Saved resume points for paused tasks (FR-E6). */
export class CheckpointStore {
  constructor(private readonly db: SqlClient) {}

  async save(input: Checkpoint): Promise<void> {
    const c = Checkpoint.parse(input);
    await this.db.query(
      `INSERT INTO checkpoints (task_id, run_id, harness, branch, head_sha, transcript_uri, session_ref, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [c.task_id, c.run_id, c.harness, c.branch, c.head_sha, c.transcript_uri, c.session_ref, c.created_at],
    );
  }

  async latest(taskId: string, repo: string): Promise<Checkpoint | null> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM checkpoints WHERE task_id = $1 ORDER BY id DESC LIMIT 1",
      [taskId],
    );
    const r = rows[0];
    if (!r) return null;
    return Checkpoint.parse({
      task_id: r.task_id,
      run_id: r.run_id,
      harness: r.harness,
      repo,
      branch: r.branch,
      head_sha: r.head_sha,
      transcript_uri: r.transcript_uri,
      session_ref: r.session_ref,
      created_at: (r.created_at as Date).toISOString(),
    });
  }
}
