import { z } from "zod";

/** Current version of every wire contract in this directory. Bump on breaking changes. */
export const CONTRACT_VERSION = 1 as const;

export const Role = z.enum([
  "concierge",
  "orchestrator",
  "architect",
  "planner",
  "worker",
  "reviewer",
  "librarian",
]);
export type Role = z.infer<typeof Role>;

/** "org/name" on the code host. */
export const RepoName = z.string().regex(/^[\w.-]+\/[\w.-]+$/, "expected org/name");

export const TaskId = z.uuid();
export const RunId = z.uuid();
export const MessageId = z.uuid();
/** Decision records are numbered: D-0001, D-0002, ... */
export const DecisionId = z.string().regex(/^D-\d{4,}$/, "expected D-0001 style id");

/**
 * A pointer to something an agent can load on demand (FR-M3). Messages carry
 * refs, never pasted content.
 */
export const Ref = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    repo: RepoName,
    path: z.string().min(1),
    sha: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
  }),
  z.object({
    kind: z.literal("commit"),
    repo: RepoName,
    branch: z.string().min(1),
    sha: z.string().regex(/^[0-9a-f]{40}$/),
  }),
  z.object({ kind: z.literal("context"), path: z.string().min(1) }),
  z.object({ kind: z.literal("decision"), id: DecisionId }),
  z.object({ kind: z.literal("task"), id: TaskId }),
  z.object({ kind: z.literal("run"), id: RunId }),
  z.object({ kind: z.literal("pr"), repo: RepoName, number: z.number().int().positive() }),
  z.object({
    kind: z.literal("thread"),
    provider: z.enum(["slack", "github", "cli"]),
    id: z.string().min(1),
  }),
  z.object({ kind: z.literal("transcript"), uri: z.string().min(1) }),
  z.object({ kind: z.literal("url"), url: z.url() }),
]);
export type Ref = z.infer<typeof Ref>;

/** Limits that hard-stop a task or role (FR-K2). Every field is a ceiling. */
export const Budget = z.object({
  usd: z.number().positive(),
  tokens: z.number().int().positive(),
  minutes: z.number().positive(),
  retries: z.number().int().min(0).max(10),
});
export type Budget = z.infer<typeof Budget>;

/** What a task may touch. Paths are globs relative to the repo root (advisory, FR-O6). */
export const Scope = z.object({
  repo: RepoName,
  paths: z.array(z.string().min(1)).min(1),
});
export type Scope = z.infer<typeof Scope>;

/** Token and dollar usage for one run, as recorded in the ledger (FR-K1). */
export const Usage = z.object({
  model: z.string().min(1),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cacheReadTokens: z.number().int().min(0),
  cacheWriteTokens: z.number().int().min(0),
  /** Null when the cost is unknown (no price for the model): never recorded as zero. */
  usd: z.number().min(0).nullable(),
  durationMs: z.number().int().min(0),
});
export type Usage = z.infer<typeof Usage>;
