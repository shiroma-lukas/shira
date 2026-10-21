import { PGlite } from "@electric-sql/pglite";
import { APP_ROLE } from "../src/db/app-role.js";
import { fromPGlite, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import type { NewTask } from "../src/queue/store.js";

/**
 * A fresh, migrated in-process database with one onboarded repo, "o/r". Tests then run
 * as the app role, so code that needs a privilege production doesn't grant fails here.
 */
export async function testDb(): Promise<Db> {
  const db = fromPGlite(new PGlite());
  await migrate(db);
  await db.query("INSERT INTO repos (repo, config_ref) VALUES ('o/r', 'repos/r.yaml')");
  await db.exec(`SET ROLE ${APP_ROLE}`);
  return db;
}

/** Runs `fn` as the admin user that owns the schema, for setup the app role may not do. */
export async function asAdmin<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  await db.exec("RESET ROLE");
  try {
    return await fn();
  } finally {
    await db.exec(`SET ROLE ${APP_ROLE}`);
  }
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
