import type { LaunchProcess, Workspace } from "../contracts/adapter.js";
import type { RepoConfig } from "../contracts/index.js";

export interface SandboxSpec {
  taskId: string;
  repo: RepoConfig;
  branch: string;
  /** Resume point: check out the task branch at this commit. Absent for a fresh start from the default branch. */
  checkpointSha?: string;
  /** How the agent's harness reaches its model provider. */
  harness?: HarnessAccess;
}

/** What a sandbox needs to run one agent's harness: its model provider's credential and hosts. */
export interface HarnessAccess {
  /** Passed to processes started with `launch` only, never to `exec`. */
  env: Record<string, string>;
  /** Hosts added to the sandbox's egress allowlist. */
  egress: string[];
}

export type RepoAccess = "read" | "write";

/**
 * Supplies git credentials for one repo at a time (FR-E3). Production: the GitHub
 * App. Credentials go to individual platform-run git commands, never into the
 * workspace, so the agent cannot push.
 */
export interface RepoCredentials {
  cloneUrl(repo: string): string;
  /** Environment variables that authenticate one git command. */
  gitEnv(repo: string, access: RepoAccess): Promise<Record<string, string>>;
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
  /**
   * Runs a shell command in the workspace. `auth` adds repo credentials for that one
   * command; the dispatcher uses it to fetch and push after the agent has exited.
   */
  exec(command: string, opts?: { timeoutMs?: number; auth?: RepoAccess }): Promise<ExecResult>;
  /** Starts a long-running process (the harness) in the workspace. */
  launch: LaunchProcess;
  /**
   * Writes a file for the agent to read, outside the repo so it never shows up in the
   * diff. Returns its absolute path inside the sandbox.
   */
  writeFile(name: string, content: string): Promise<string>;
  destroy(): Promise<void>;
}

/** File names allowed for `writeFile`: no paths, so writes can't land inside the repo. */
export const ATTACHMENT_NAME = /^[\w][\w.-]{0,99}$/;

export interface SandboxProvider {
  /** Returns a sandbox with the repo cloned and `spec.branch` checked out. */
  create(spec: SandboxSpec): Promise<Sandbox>;
}
