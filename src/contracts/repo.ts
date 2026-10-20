import { z } from "zod";
import { RepoName } from "./common.js";
import { API_VERSION } from "./agent.js";

/**
 * Per-repo onboarding config (FR-A4). A repo without one cannot receive tasks.
 * The test command is what the rebase-and-test gate runs (FR-O3).
 */
export const RepoConfig = z.object({
  apiVersion: z.literal(API_VERSION),
  kind: z.literal("Repo"),
  repo: RepoName,
  defaultBranch: z.string().min(1).default("main"),
  /** Container image with the repo's toolchain. Pin by digest or exact tag. */
  image: z.string().min(1),
  setup: z.array(z.string().min(1)).default([]),
  test: z.string().min(1),
  lint: z.string().min(1).optional(),
  flaky: z
    .object({
      /** Test ids or globs excluded from the gate until fixed. */
      quarantine: z.array(z.string().min(1)).default([]),
      /** Re-runs of a failing test before it counts as a real failure. */
      retries: z.number().int().min(0).max(3).default(0),
    })
    .default({ quarantine: [], retries: 0 }),
  /** Hosts reachable through the egress proxy, in addition to the platform default list (FR-E4). */
  egress: z.object({ allow: z.array(z.string().min(1)).default([]) }).default({ allow: [] }),
  limits: z
    .object({
      minutes: z.number().positive().default(60),
      cpus: z.number().positive().default(2),
      memoryMb: z.number().int().positive().default(4096),
    })
    .default({ minutes: 60, cpus: 2, memoryMb: 4096 }),
});
export type RepoConfig = z.infer<typeof RepoConfig>;
