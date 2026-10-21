import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureAppUser, excessPrivileges, scramVerifier } from "../src/db/app-role.js";
import { fromPGlite } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { asAdmin, newTask, testDb } from "./helpers.js";
import { TaskStore } from "../src/queue/store.js";

describe("shira_app role", () => {
  it("can't delete, rewrite the audit log, or change the schema", async () => {
    const db = await testDb();
    const task = await new TaskStore(db).create(newTask(), "a");
    await expect(db.query("DELETE FROM tasks")).rejects.toThrow(/permission denied/);
    await expect(db.query("DELETE FROM runs")).rejects.toThrow(/permission denied/);
    // Denied by the grant, before the append-only trigger is even reached.
    await expect(db.query("UPDATE task_events SET actor = 'x'")).rejects.toThrow(/permission denied/);
    await expect(db.query("DELETE FROM task_events WHERE task_id = $1", [task.id])).rejects.toThrow(/permission denied/);
    await expect(db.query("INSERT INTO decisions (id, record_ref, approver_id) VALUES ('D-0001', 'x', 'y')")).rejects.toThrow(
      /permission denied/,
    );
    await expect(db.exec("DROP TRIGGER task_events_append_only ON task_events")).rejects.toThrow(/must be owner/);
    await expect(db.exec("ALTER TABLE tasks ADD COLUMN x int")).rejects.toThrow(/must be owner/);
    await expect(db.exec("CREATE TABLE sneaky (id int)")).rejects.toThrow(/permission denied/);
    await expect(db.query("SELECT * FROM schema_migrations")).rejects.toThrow(/permission denied/);
  });

  it("re-runs cleanly when the role already exists in the cluster", async () => {
    const db = await testDb();
    await asAdmin(db, async () => {
      await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      expect(await migrate(db)).toContain("0005_app_role.sql");
    });
  });

  it("warns about connections with more rights than the dispatcher needs", async () => {
    const db = await testDb();
    expect(await excessPrivileges(db)).toBeNull();
    expect(await asAdmin(db, () => excessPrivileges(db))).toMatch(/superuser/);
  });
});

describe("ensureAppUser", () => {
  const db = fromPGlite(new PGlite());
  beforeAll(() => migrate(db));

  it("creates a login user in the app role, then updates it", async () => {
    expect(await ensureAppUser(db, "shira_dispatcher", "correct-horse-battery")).toBe("created");
    expect(await ensureAppUser(db, "shira_dispatcher", "another-long-password")).toBe("updated");
    const { rows } = await db.query<{ login: boolean; member: boolean; verifier: string }>(
      `SELECT rolcanlogin AS login, pg_has_role('shira_dispatcher', 'shira_app', 'MEMBER') AS member, rolpassword AS verifier
       FROM pg_authid WHERE rolname = 'shira_dispatcher'`,
    );
    expect(rows[0]).toMatchObject({ login: true, member: true });
    expect(rows[0]!.verifier).toMatch(/^SCRAM-SHA-256\$4096:/);
  });

  it("refuses unsafe names and short passwords", async () => {
    await expect(ensureAppUser(db, "x; DROP TABLE tasks", "correct-horse-battery")).rejects.toThrow(/invalid user name/);
    await expect(ensureAppUser(db, "shira_app", "correct-horse-battery")).rejects.toThrow(/group role/);
    await expect(ensureAppUser(db, "shira_dispatcher", "short")).rejects.toThrow(/16 characters/);
  });
});

describe("scramVerifier", () => {
  it("matches the RFC 7677 test vector", () => {
    // RFC 7677 section 3: user "user", password "pencil", this salt, 4096 iterations.
    // StoredKey and ServerKey derived from the RFC's SaltedPassword.
    const v = scramVerifier("pencil", Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64"));
    expect(v).toBe(
      "SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU=",
    );
  });
});
