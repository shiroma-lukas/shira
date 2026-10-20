// Runs against a real Postgres, because PGlite has a single connection and cannot
// exercise concurrent claims. Skipped unless SHIRA_TEST_DATABASE_URL is set; it drops and
// recreates the public schema, so never point it at a database you care about.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fromPool, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { TaskStore } from "../src/queue/store.js";
import { newTask } from "./helpers.js";

const url = process.env.SHIRA_TEST_DATABASE_URL;

describe.skipIf(!url)("Postgres integration", () => {
  let pool: pg.Pool;
  let db: Db;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 20 });
    db = fromPool(pool);
    await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(db);
    await db.query("INSERT INTO repos (repo, config_ref) VALUES ('o/r', 'repos/r.yaml')");
  });

  afterAll(() => pool?.end());

  it("never hands the same task to two concurrent dispatchers", async () => {
    const store = new TaskStore(db);
    for (let i = 0; i < 10; i++) await store.create(newTask({ goal: `task ${i}` }), "a");

    const claims = await Promise.all(Array.from({ length: 15 }, (_, i) => store.claim(`d${i}`, 60_000)));
    const claimed = claims.filter((t) => t !== null).map((t) => t.id);

    expect(new Set(claimed).size).toBe(claimed.length);
    // SKIP LOCKED can make a claim come back empty while rows are still queued, so
    // drain whatever is left and check every task is claimed exactly once.
    let next;
    while ((next = await store.claim("drain", 60_000))) claimed.push(next.id);
    expect(claimed).toHaveLength(10);
    expect(new Set(claimed).size).toBe(10);
  });
});
