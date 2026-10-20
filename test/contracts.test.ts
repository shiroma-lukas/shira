import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  Answer,
  assertTransition,
  canTransition,
  Checkpoint,
  Envelope,
  Reply,
  TaskStatus,
  TERMINAL_STATUSES,
} from "../src/contracts/index.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../examples/handoff/${name}`, import.meta.url), "utf8"));

describe("handoff walkthrough (examples/handoff)", () => {
  const envelope = Envelope.parse(fixture("01-envelope.json"));
  const question = Reply.parse(fixture("02-reply-needs-decision.json"));
  const checkpoint = Checkpoint.parse(fixture("03-checkpoint.json"));
  const answer = Answer.parse(fixture("04-answer.json"));
  const done = Reply.parse(fixture("05-reply-done.json"));

  it("links every message to the same task", () => {
    for (const m of [question, checkpoint, answer, done]) expect(m.task_id).toBe(envelope.task_id);
  });

  it("chains replies to the envelope and the answer to the question", () => {
    expect(question.in_reply_to).toBe(envelope.id);
    expect(done.in_reply_to).toBe(envelope.id);
    expect(answer.in_reply_to).toBe(question.id);
  });

  it("walks a legal status path through pause and resume", () => {
    const path: TaskStatus[] = ["queued", "running", question.status, "queued", "running", done.status];
    for (let i = 1; i < path.length; i++) assertTransition(path[i - 1]!, path[i]!);
  });
});

describe("Envelope", () => {
  const base = fixture("01-envelope.json") as Record<string, unknown>;

  it("rejects pasted content in place of a goal", () => {
    expect(Envelope.safeParse({ ...base, goal: "x".repeat(501) }).success).toBe(false);
  });

  it("requires at least one done_when criterion", () => {
    expect(Envelope.safeParse({ ...base, done_when: [] }).success).toBe(false);
  });

  it("rejects unknown ref kinds", () => {
    expect(Envelope.safeParse({ ...base, refs: [{ kind: "blob", data: "..." }] }).success).toBe(false);
  });
});

describe("Reply", () => {
  const done = fixture("05-reply-done.json") as Record<string, unknown>;

  it("caps the summary at three lines", () => {
    expect(Reply.safeParse({ ...done, summary: "a\nb\nc\nd" }).success).toBe(false);
  });

  it("requires a question for needs_decision and forbids it otherwise", () => {
    expect(Reply.safeParse({ ...done, status: "needs_decision" }).success).toBe(false);
    const q = (fixture("02-reply-needs-decision.json") as { question: unknown }).question;
    expect(Reply.safeParse({ ...done, question: q }).success).toBe(false);
  });

  it("requires an artifact for done", () => {
    const { artifact: _, ...noArtifact } = done;
    expect(Reply.safeParse(noArtifact).success).toBe(false);
  });
});

describe("task transitions", () => {
  it("never leaves a terminal state", () => {
    for (const from of TERMINAL_STATUSES)
      for (const to of TaskStatus.options) expect(canTransition(from, to)).toBe(false);
  });

  it("resumes only through the queue", () => {
    for (const from of ["needs_decision", "paused", "blocked"] as const) {
      expect(canTransition(from, "running")).toBe(false);
      expect(canTransition(from, "queued")).toBe(true);
    }
  });
});
