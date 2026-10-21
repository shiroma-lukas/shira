import { describe, expect, it } from "vitest";
import type { RunOutcome } from "../src/contracts/adapter.js";
import { exceededBudget, formatUsd, Ledger } from "../src/ledger/ledger.js";
import { TaskStore } from "../src/queue/store.js";
import { newTask, testDb } from "./helpers.js";

const outcome = (usd: number | null, tokens: number, durationMs: number): RunOutcome => ({
  kind: "aborted",
  reason: "error",
  transcriptUri: "file:///t",
  sessionRef: null,
  usage: { model: "m", inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd, durationMs },
});

describe("Ledger", () => {
  it("numbers attempts and sums spend across runs of a task", async () => {
    const db = await testDb();
    const task = await new TaskStore(db).create(newTask(), "a");
    const ledger = new Ledger(db);

    const r1 = await ledger.startRun({ taskId: task.id, role: "worker", harness: "fake", model: "m" });
    await ledger.finishRun(r1.id, outcome(1.25, 1000, 60_000));
    const r2 = await ledger.startRun({ taskId: task.id, role: "worker", harness: "fake", model: "m" });
    await ledger.finishRun(r2.id, outcome(0.5, 500, 30_000));

    expect([r1.attempt, r2.attempt]).toEqual([1, 2]);
    expect(await ledger.taskSpend(task.id)).toEqual({ usd: 1.75, unpricedRuns: 0, tokens: 1500, minutes: 1.5 });
    expect(await ledger.monthSpendUsd()).toBe(1.75);
  });

  it("keeps unknown cost apart from known spend instead of counting it as zero", async () => {
    const db = await testDb();
    const task = await new TaskStore(db).create(newTask(), "a");
    const ledger = new Ledger(db);
    for (const usd of [0.25, null, null]) {
      const r = await ledger.startRun({ taskId: task.id, role: "worker", harness: "fake", model: "m" });
      await ledger.finishRun(r.id, outcome(usd, 100, 60_000));
    }
    const spend = await ledger.taskSpend(task.id);
    expect(spend).toEqual({ usd: 0.25, unpricedRuns: 2, tokens: 300, minutes: 3 });
    expect(formatUsd(spend)).toBe("$0.25 + unknown (2 unpriced runs)");
    expect(formatUsd({ usd: 1, unpricedRuns: 0 })).toBe("$1.00");
    const { rows } = await db.query<{ usd: string | null }>("SELECT usd FROM runs WHERE usd IS NULL");
    expect(rows).toHaveLength(2);
  });

  it("does not overwrite a finished run", async () => {
    const db = await testDb();
    const task = await new TaskStore(db).create(newTask(), "a");
    const ledger = new Ledger(db);
    const r = await ledger.startRun({ taskId: task.id, role: "worker", harness: "fake", model: "m" });
    await ledger.finishRun(r.id, outcome(1, 1, 1));
    await ledger.finishRun(r.id, outcome(99, 1, 1));
    expect((await ledger.taskSpend(task.id)).usd).toBe(1);
  });
});

describe("exceededBudget", () => {
  const budget = { usd: 5, tokens: 1000, minutes: 10, retries: 0 };
  it("reports the first exhausted dimension", () => {
    expect(exceededBudget(budget, { usd: 1, tokens: 10, minutes: 1 })).toBeNull();
    expect(exceededBudget(budget, { usd: 5, tokens: 10, minutes: 1 })).toBe("usd");
    expect(exceededBudget(budget, { usd: 1, tokens: 1000, minutes: 1 })).toBe("tokens");
    expect(exceededBudget(budget, { usd: 1, tokens: 10, minutes: 10 })).toBe("minutes");
  });
});
