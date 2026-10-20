import { z } from "zod";
import { Budget, CONTRACT_VERSION, DecisionId, MessageId, Ref, Role, Scope, TaskId } from "./common.js";
import { ReplyStatus } from "./status.js";

/** Short, single-purpose text. Long content belongs behind a Ref. */
const terse = (max: number) => z.string().trim().min(1).max(max);

/**
 * A unit of work handed from one agent to another (FR-M1). It names the goal and
 * points at everything else (FR-M3).
 */
export const Envelope = z.object({
  v: z.literal(CONTRACT_VERSION),
  id: MessageId,
  task_id: TaskId,
  from: Role,
  to: Role,
  goal: terse(500),
  refs: z.array(Ref).max(50),
  scope: Scope,
  /** Checkable completion criteria, e.g. "pnpm test passes", "PR opened against main". */
  done_when: z.array(terse(200)).min(1).max(10),
  budget: Budget,
});
export type Envelope = z.infer<typeof Envelope>;

/** A question an agent needs a decision on before it can continue (Flow C). */
export const Question = z.object({
  /** Routes the question: technical -> tech lead (architect from M4), business -> concierge (FR-M5). */
  kind: z.enum(["technical", "business"]),
  text: terse(1000),
  options: z.array(terse(200)).min(2).max(6).optional(),
  refs: z.array(Ref).max(20).default([]),
});
export type Question = z.infer<typeof Question>;

const MAX_SUMMARY_LINES = 3;

/** An agent's answer to an envelope (FR-M2). */
export const Reply = z
  .object({
    v: z.literal(CONTRACT_VERSION),
    id: MessageId,
    task_id: TaskId,
    in_reply_to: MessageId,
    from: Role,
    status: ReplyStatus,
    summary: terse(600).refine(
      (s) => s.split("\n").length <= MAX_SUMMARY_LINES,
      `summary must be at most ${MAX_SUMMARY_LINES} lines`,
    ),
    /**
     * The thing produced. Workers return the commit on their task branch; the platform,
     * not the worker, rebases, tests, and opens the PR (FR-O3, FR-S3).
     */
    artifact: Ref.optional(),
    question: Question.optional(),
    blocked_by: z.array(TaskId).optional(),
  })
  .superRefine((r, ctx) => {
    if (r.status === "needs_decision" && !r.question) {
      ctx.addIssue({ code: "custom", path: ["question"], message: "needs_decision requires a question" });
    }
    if (r.status !== "needs_decision" && r.question) {
      ctx.addIssue({ code: "custom", path: ["question"], message: "question is only allowed with needs_decision" });
    }
    if (r.status === "done" && !r.artifact) {
      ctx.addIssue({ code: "custom", path: ["artifact"], message: "done requires an artifact" });
    }
  });
export type Reply = z.infer<typeof Reply>;

/** A human's answer to a needs_decision reply. Moves the task back to queued for resume. */
export const Answer = z.object({
  v: z.literal(CONTRACT_VERSION),
  task_id: TaskId,
  /** The id of the needs_decision Reply being answered. */
  in_reply_to: MessageId,
  /** Identity id of the person who answered (must be allowed to decide this question). */
  answered_by: z.string().min(1),
  text: terse(2000),
  choice: z.number().int().min(0).optional(),
  /** Set when the answer was recorded as a decision record (FR-C2). */
  decision_id: DecisionId.optional(),
});
export type Answer = z.infer<typeof Answer>;
