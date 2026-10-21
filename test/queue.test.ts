import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client.js";
import { Settings } from "../src/queue/settings.js";
import { TaskConflictError, TaskStore } from "../src/queue/store.js";
import { asAdmin, newTask, testDb } from "./helpers.js";

describe("TaskStore", () => {
  let db: Db;
  let store: TaskStore;

  beforeEach(async () => {
    db = await testDb();
    store = new TaskStore(db);
  });

  it("creates a queued task and logs it", async () => {
    const t = await store.create(newTask(), "cli:test");
    expect(t.status).toBe("queued");
    const events = await store.events(t.id);
    expect(events.map((e) => [e.kind, e.toStatus])).toEqual([["state_change", "queued"]]);
  });

  it("refuses repos that are not onboarded or are disabled", async () => {
    await expect(store.create(newTask({ repo: "o/x", scope: { repo: "o/x", paths: ["**"] } }), "a")).rejects.toThrow(/not onboarded/);
    // Disabling a repo is an operator action; the app role can't.
    await expect(db.query("UPDATE repos SET enabled = false")).rejects.toThrow(/permission denied/);
    await asAdmin(db, () => db.query("UPDATE repos SET enabled = false"));
    await expect(store.create(newTask(), "a")).rejects.toThrow(/disabled/);
  });

  it("claims by priority, then age, and leases the task", async () => {
    const low = await store.create(newTask({ goal: "low" }), "a");
    const high = await store.create(newTask({ goal: "high", priority: 5 }), "a");
    const first = await store.claim("d1", 60_000);
    expect(first?.id).toBe(high.id);
    expect(first?.status).toBe("running");
    expect(first?.leaseOwner).toBe("d1");
    expect(first?.attempts).toBe(1);
    expect((await store.claim("d1", 60_000))?.id).toBe(low.id);
    expect(await store.claim("d1", 60_000)).toBeNull();
  });

  it("does not claim a task whose blocker is unfinished", async () => {
    const blocker = await store.create(newTask({ goal: "first" }), "a");
    await store.create(newTask({ goal: "second", priority: 9, blockedBy: [blocker.id] }), "a");
    expect((await store.claim("d1", 60_000))?.id).toBe(blocker.id);
    expect(await store.claim("d1", 60_000)).toBeNull();
    await store.transition(blocker.id, "done", { actor: "worker" });
    expect((await store.claim("d1", 60_000))?.goal).toBe("second");
  });

  it("claims nothing while the kill switch is on", async () => {
    await store.create(newTask(), "a");
    const settings = new Settings(db);
    await settings.setAgentsPaused(true, "admin");
    expect(await store.claim("d1", 60_000)).toBeNull();
    await settings.setAgentsPaused(false, "admin");
    expect(await store.claim("d1", 60_000)).not.toBeNull();
  });

  it("rejects illegal transitions and stale expectations", async () => {
    const t = await store.create(newTask(), "a");
    await expect(store.transition(t.id, "done", { actor: "x" })).rejects.toThrow(/illegal task transition/);
    await expect(store.transition(t.id, "cancelled", { actor: "x", from: "running" })).rejects.toBeInstanceOf(TaskConflictError);
  });

  it("clears the lease when a task leaves running", async () => {
    const t = await store.create(newTask(), "a");
    await store.claim("d1", 60_000);
    const paused = await store.transition(t.id, "needs_decision", { actor: "worker" });
    expect(paused.leaseOwner).toBeNull();
    expect(paused.leaseExpiresAt).toBeNull();
  });

  it("retries up to budget.retries, then fails", async () => {
    const t = await store.create(newTask(), "a"); // retries: 1
    await store.claim("d1", 60_000);
    const retried = await store.retryOrFail(t.id, "d1", "harness crashed");
    expect(retried.status).toBe("queued");
    expect(retried.retriesUsed).toBe(1);
    await store.claim("d1", 60_000);
    const failed = await store.retryOrFail(t.id, "d1", "harness crashed");
    expect(failed.status).toBe("failed");
  });

  it("does not count a resume after a decision as a retry", async () => {
    const t = await store.create(newTask(), "a");
    await store.claim("d1", 60_000);
    await store.transition(t.id, "needs_decision", { actor: "worker" });
    await store.transition(t.id, "queued", { actor: "tech-lead-1" });
    const resumed = await store.claim("d1", 60_000);
    expect(resumed?.attempts).toBe(2);
    expect(resumed?.retriesUsed).toBe(0);
  });

  it("stops renewing a lease once the task is cancelled", async () => {
    const t = await store.create(newTask(), "a");
    await store.claim("d1", 60_000);
    expect(await store.renewLease(t.id, "d1", 60_000)).toBe(true);
    expect(await store.renewLease(t.id, "d2", 60_000)).toBe(false);
    await store.cancel(t.id, "cli:test", "changed my mind");
    expect(await store.renewLease(t.id, "d1", 60_000)).toBe(false);
  });

  it("reaps expired leases as failed attempts", async () => {
    const t = await store.create(newTask(), "a");
    await store.claim("d1", 1);
    await db.query("UPDATE tasks SET lease_expires_at = now() - interval '1 second'");
    const [reaped] = await store.reapExpiredLeases();
    expect(reaped?.id).toBe(t.id);
    expect(reaped?.status).toBe("queued");
    expect(reaped?.retriesUsed).toBe(1);
  });
});
