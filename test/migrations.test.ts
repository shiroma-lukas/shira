import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { fromPGlite } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";

describe("migrations", () => {
  const db = fromPGlite(new PGlite());
  let taskId: string;

  beforeAll(async () => {
    await migrate(db);
    await db.query("INSERT INTO repos (repo, config_ref) VALUES ('o/r', 'repos/r.yaml')");
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO tasks (requester, repo, goal, role, budget, scope)
       VALUES ('cli:me', 'o/r', 'fix bug', 'worker', '{}', '{}') RETURNING id`,
    );
    taskId = rows[0]!.id;
  });

  it("is idempotent", async () => {
    expect(await migrate(db)).toEqual([]);
  });

  it("keeps task_events append-only", async () => {
    await db.query("INSERT INTO task_events (task_id, kind, actor) VALUES ($1, 'note', 'platform')", [taskId]);
    await expect(db.query("UPDATE task_events SET actor = 'x'")).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM task_events")).rejects.toThrow(/append-only/);
  });

  it("rejects unknown task statuses", async () => {
    await expect(db.query("UPDATE tasks SET status = 'sleeping' WHERE id = $1", [taskId])).rejects.toThrow();
  });

  it("stores a checkpoint for a run and returns the latest", async () => {
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO runs (task_id, attempt, role, harness, model) VALUES ($1, 1, 'worker', 'claude-code', 'm') RETURNING id",
      [taskId],
    );
    const sha = "a".repeat(40);
    await db.query(
      `INSERT INTO checkpoints (task_id, run_id, harness, branch, head_sha, transcript_uri)
       VALUES ($1, $2, 'claude-code', 'shira/x', $3, 's3://t')`,
      [taskId, rows[0]!.id, sha],
    );
    await expect(
      db.query(
        `INSERT INTO checkpoints (task_id, run_id, harness, branch, head_sha, transcript_uri)
         VALUES ($1, $2, 'claude-code', 'shira/x', 'not-a-sha', 's3://t')`,
        [taskId, rows[0]!.id],
      ),
    ).rejects.toThrow();
    const latest = await db.query<{ head_sha: string }>(
      "SELECT head_sha FROM checkpoints WHERE task_id = $1 ORDER BY id DESC LIMIT 1",
      [taskId],
    );
    expect(latest.rows[0]?.head_sha).toBe(sha);
  });
});
