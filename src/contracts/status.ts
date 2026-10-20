import { z } from "zod";

/** Task lifecycle states (FR-Q2). */
export const TaskStatus = z.enum([
  "queued",
  "running",
  "needs_decision",
  "paused",
  "blocked",
  "done",
  "failed",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** Statuses an agent may return in a reply (FR-M2). */
export const ReplyStatus = z.enum(["done", "blocked", "needs_decision", "failed"]);
export type ReplyStatus = z.infer<typeof ReplyStatus>;

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(["done", "failed", "cancelled"]);

/**
 * Allowed task state changes. Enforced in code (FR-S3); anything not listed is rejected.
 *
 * - running -> queued covers a retry or a lost lease.
 * - needs_decision / paused / blocked -> queued is how a task resumes: it goes back
 *   through the queue and is rehydrated from its latest checkpoint (FR-E6).
 */
const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["running", "blocked", "cancelled"],
  running: ["done", "failed", "needs_decision", "paused", "blocked", "queued", "cancelled"],
  needs_decision: ["queued", "cancelled"],
  paused: ["queued", "cancelled"],
  blocked: ["queued", "cancelled"],
  done: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal task transition: ${from} -> ${to}`);
  }
}
