import { PGlite } from "@electric-sql/pglite";
import { fromPGlite, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import type { NewTask } from "../src/queue/store.js";

/** A fresh, migrated in-process database with one onboarded repo, "o/r". */
export async function testDb(): Promise<Db> {
  const db = fromPGlite(new PGlite());
  await migrate(db);
  await db.query("INSERT INTO repos (repo, config_ref) VALUES ('o/r', 'repos/r.yaml')");
  return db;
}

export const newTask = (overrides: Partial<NewTask> = {}): NewTask => ({
  requester: "cli:test",
  repo: "o/r",
  goal: "fix the bug",
  role: "worker",
  budget: { usd: 5, tokens: 1_000_000, minutes: 30, retries: 1 },
  scope: { repo: "o/r", paths: ["**"] },
  ...overrides,
});
