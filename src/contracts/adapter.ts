import { z } from "zod";
import { RepoName, RunId, TaskId, Usage } from "./common.js";
import type { Answer, Envelope, Question, Reply } from "./envelope.js";

/**
 * Saved state that lets a paused task continue in a fresh sandbox (FR-E6).
 * Written when a task leaves `running` for `needs_decision` or `paused`.
 */
export const Checkpoint = z.object({
  task_id: TaskId,
  run_id: RunId,
  harness: z.string().min(1),
  repo: RepoName,
  branch: z.string().min(1),
  /** The commit the worker had pushed when it stopped. Work in progress is committed before checkpointing. */
  head_sha: z.string().regex(/^[0-9a-f]{40}$/),
  transcript_uri: z.string().min(1),
  /** Harness-native session id, if the harness can resume natively. Null means resume by replay. */
  session_ref: z.string().min(1).nullable(),
  created_at: z.iso.datetime(),
});
export type Checkpoint = z.infer<typeof Checkpoint>;

/** A prepared checkout inside the task's sandbox. The platform creates it; adapters only use it. */
export interface Workspace {
  repo: string;
  branch: string;
  /** Absolute path inside the sandbox. */
  path: string;
}

/** A process running inside the task's sandbox. */
export interface HarnessProcess {
  /** stdout, split into lines. */
  lines: AsyncIterable<string>;
  exited: Promise<{ code: number; stderr: string }>;
  kill(): void;
}

/**
 * Starts a process inside the sandbox, in the workspace directory. The sandbox
 * provides credentials and egress policy; adapters never see host secrets directly.
 */
export type LaunchProcess = (argv: string[]) => HarnessProcess;

export interface StartInput {
  runId: string;
  envelope: Envelope;
  workspace: Workspace;
  launch: LaunchProcess;
  model: string;
  /** Resolved canonical instructions for the role; adapters apply their own shim (FR-X4). */
  instructions: string;
  /** Tool ids from the agent definition. Adapters map them to harness tools and deny the rest. */
  tools: readonly string[];
  /** What is left of the task budget. Adapters enforce it mid-run where the harness allows. */
  remaining: { usd: number };
}

export interface ResumeInput extends StartInput {
  checkpoint: Checkpoint;
  /** The question that paused the task, when resuming from needs_decision. */
  question?: Question;
  /** Present when resuming from needs_decision; absent when resuming from a manual pause. */
  answer?: Answer;
}

/** Opaque handle to a live harness session. */
export interface SessionHandle {
  harness: string;
  runId: string;
  sessionRef: string | null;
}

interface RunOutcomeBase {
  usage: Usage;
  transcriptUri: string;
  /** Needed to write a checkpoint if the reply is needs_decision. */
  sessionRef: string | null;
}

/** How a run ended: the agent replied, or the platform stopped it. */
export type RunOutcome =
  | (RunOutcomeBase & { kind: "reply"; reply: Reply })
  | (RunOutcomeBase & { kind: "aborted"; reason: "cancelled" | "timeout" | "budget_exceeded" | "error"; detail?: string });

/**
 * Contract every harness (Claude Code, and others from M3) implements (FR-X1).
 *
 * The platform owns sandboxes, credentials, budgets, and the queue. An adapter
 * only drives one harness session inside a sandbox the platform already set up.
 */
export interface HarnessAdapter {
  /** Stable id used in agent definitions, e.g. "claude-code". */
  readonly id: string;
  readonly capabilities: {
    /** True if `resume` can restore a native session; otherwise it replays from transcript and branch. */
    nativeResume: boolean;
  };

  start(input: StartInput): Promise<SessionHandle>;
  /** Mid-run message to the agent, e.g. a budget warning. */
  send(session: SessionHandle, text: string): Promise<void>;
  /** Continue a checkpointed task. Must work for every adapter, natively or by replay. */
  resume(input: ResumeInput): Promise<SessionHandle>;
  cancel(session: SessionHandle): Promise<void>;
  /** Resolves when the session ends, with usage for the ledger (FR-K1). */
  result(session: SessionHandle): Promise<RunOutcome>;
}
