// Runs against a real Postgres, because PGlite has a single connection and cannot
// exercise concurrent claims. Skipped unless SHIRA_TEST_DATABASE_URL is set (environment or
// .env); it drops and recreates the public schema, so never point it at a database you care about.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadDotEnv } from "../src/cli/env.js";
import { randomBytes } from "node:crypto";
import { ensureAppUser, excessPrivileges } from "../src/db/app-role.js";
import { fromPool, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { TaskStore } from "../src/queue/store.js";
import { newTask } from "./helpers.js";

loadDotEnv();
const url = process.env.SHIRA_TEST_DATABASE_URL;

describe.skipIf(!url)("Postgres integration", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let db: Db;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: url, max: 2 });
    const admin = fromPool(adminPool);
    await admin.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(admin);
    await admin.query("INSERT INTO repos (repo, config_ref) VALUES ('o/r', 'repos/r.yaml')");

    // The rest runs as a real login user in the app role, as dispatchers do in production.
    const password = randomBytes(18).toString("base64url");
    await ensureAppUser(admin, "shira_test_app", password);
    const appUrl = new URL(url!);
    appUrl.username = "shira_test_app";
    appUrl.password = password;
    pool = new pg.Pool({ connectionString: appUrl.href, max: 20 });
    db = fromPool(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
  });

  it("manages the app user as a non-superuser admin, as on RDS", async () => {
    // RDS's master user has CREATEROLE but not SUPERUSER, and administers shira_app because
    // it created it. Roles are cluster-wide, so set this one up idempotently.
    const admin = fromPool(adminPool);
    await admin.exec(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shira_test_rds_admin') THEN
        CREATE ROLE shira_test_rds_admin NOLOGIN CREATEROLE;
      END IF;
    END $$`);
    await admin.exec("GRANT shira_app TO shira_test_rds_admin WITH ADMIN OPTION, INHERIT FALSE, SET FALSE");
    await admin.exec("DROP ROLE IF EXISTS shira_test_rds_user");
    await admin.transaction(async (tx) => {
      await tx.exec("SET LOCAL ROLE shira_test_rds_admin");
      expect(await ensureAppUser(tx, "shira_test_rds_user", "first-long-password")).toBe("created");
      expect(await ensureAppUser(tx, "shira_test_rds_user", "second-long-password")).toBe("updated");
    });
  });

  it("logs in as the app user with no excess privileges", async () => {
    expect(await excessPrivileges(db)).toBeNull();
    await expect(db.query("DELETE FROM tasks")).rejects.toThrow(/permission denied/);
  });

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
