import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./client.js";

/** The minimum a Postgres client must offer. Fits both `pg` and PGlite. */
export interface SqlClient {
  /** Runs one or more statements without parameters. */
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** Arbitrary constant identifying Shira's migration lock. */
const MIGRATION_LOCK = 7_429_101;

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

/**
 * Applies `NNNN_name.sql` files in order, each in its own transaction, and
 * records them in schema_migrations. Returns the names it applied.
 */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const { rows } = await db.query<{ name: string }>("SELECT name FROM schema_migrations");
  const done = new Set(rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();

  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(join(dir, file), "utf8");
    try {
      const ran = await db.transaction(async (tx) => {
        // Several hosts may migrate at once on boot. The lock serializes them; whoever
        // waited re-checks and skips what the first one already applied.
        await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
        const again = await tx.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
        if (again.rows.length) return false;
        await tx.exec(sql);
        await tx.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        return true;
      });
      if (!ran) continue;
    } catch (err) {
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    }
    applied.push(file);
  }
  return applied;
}
