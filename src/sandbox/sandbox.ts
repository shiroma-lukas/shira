import type { LaunchProcess, Workspace } from "../contracts/adapter.js";
import type { RepoConfig } from "../contracts/index.js";

export interface SandboxSpec {
  taskId: string;
  repo: RepoConfig;
  branch: string;
  /** Resume point: check out the task branch at this commit. Absent for a fresh start from the default branch. */
  checkpointSha?: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * One isolated workspace for one task (FR-O2, FR-E1). The provider is responsible
 * for isolation, scoped credentials, egress policy, and resource limits (FR-E2–E5);
 * the dispatcher only runs commands in it and destroys it.
 */
export interface Sandbox {
  readonly id: string;
  readonly workspace: Workspace;
  exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecResult>;
  /** Starts a long-running process (the harness) in the workspace. */
  launch: LaunchProcess;
  destroy(): Promise<void>;
}

export interface SandboxProvider {
  /** Returns a sandbox with the repo cloned and `spec.branch` checked out. */
  create(spec: SandboxSpec): Promise<Sandbox>;
}
