import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { HarnessProcess } from "../contracts/adapter.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, RepoCredentials, Sandbox, SandboxProvider, SandboxSpec } from "./sandbox.js";

const MAX_OUTPUT = 1_000_000;

/** Runs a shell command in `cwd`, capturing at most MAX_OUTPUT bytes of each stream. */
export function sh(
  command: string,
  cwd: string,
  timeoutMs = 10 * 60_000,
  env: Record<string, string> = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout = (stdout + d).slice(-MAX_OUTPUT)));
    child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d).slice(-MAX_OUTPUT)));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 137 : 1), stdout, stderr });
    });
  });
}

/** Spawns argv directly (no shell) in `cwd`, streaming stdout by line. */
export function launch(argv: string[], cwd: string): HarnessProcess {
  const [cmd, ...args] = argv;
  if (!cmd) throw new Error("launch needs a command");
  const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d).slice(-MAX_OUTPUT)));
  const exited = new Promise<{ code: number; stderr: string }>((resolve) => {
    child.on("error", (err) => resolve({ code: 127, stderr: `${stderr}${err.message}` }));
    child.on("close", (code, signal) => resolve({ code: code ?? (signal ? 137 : 1), stderr }));
  });
  return {
    lines: createInterface({ input: child.stdout, crlfDelay: Infinity }),
    exited,
    kill() {
      child.kill("SIGTERM");
      setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 5000).unref();
    },
  };
}

async function mustSh(command: string, cwd: string, env?: Record<string, string>): Promise<void> {
  const r = await sh(command, cwd, undefined, env);
  if (r.code !== 0) throw new Error(`${command} failed (${r.code}): ${r.stderr.trim()}`);
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Development and test provider: a temp directory on the host. It provides NO
 * isolation, credentials scoping, or egress control, so it must never run untrusted
 * work. Production uses an isolated runtime (FR-E2; PRD open question 3).
 */
export class LocalSandboxProvider implements SandboxProvider {
  constructor(
    private readonly opts: {
      unsafeNoIsolation: true;
      /** Repo credentials (the GitHub App). Without them, clone and push are unauthenticated. */
      credentials?: RepoCredentials;
      /** Overrides where to clone from (tests). */
      cloneUrl?: (repo: string) => string;
    },
  ) {
    if (opts.unsafeNoIsolation !== true) throw new Error("LocalSandboxProvider requires unsafeNoIsolation: true");
  }

  async create(spec: SandboxSpec): Promise<Sandbox> {
    const root = await mkdtemp(join(tmpdir(), "shira-sandbox-"));
    const path = join(root, "repo");
    const repo = spec.repo.repo;
    const creds = this.opts.credentials;
    const url = this.opts.cloneUrl?.(repo) ?? creds?.cloneUrl(repo) ?? `https://github.com/${repo}.git`;
    const authEnv = async (access: "read" | "write" | undefined) => (access && creds ? creds.gitEnv(repo, access) : {});
    try {
      const readEnv = await authEnv("read");
      await mustSh(`git clone --quiet ${q(url)} repo`, root, readEnv);
      // An empty helper resets the list, so git can't fall back to the host's keychain and
      // let the agent push with a person's credentials.
      await mustSh(
        `git config user.name shira-worker && git config user.email shira-worker@localhost && git config credential.helper ''`,
        path,
      );
      if (spec.checkpointSha) {
        await mustSh(`git fetch --quiet origin ${q(spec.branch)}`, path, readEnv);
        await mustSh(`git checkout --quiet -B ${q(spec.branch)} ${q(spec.checkpointSha)}`, path);
      } else {
        await mustSh(`git checkout --quiet -B ${q(spec.branch)} ${q(`origin/${spec.repo.defaultBranch}`)}`, path);
      }
    } catch (err) {
      await rm(root, { recursive: true, force: true });
      throw err;
    }
    return {
      id: `local-${randomUUID()}`,
      workspace: { repo: spec.repo.repo, branch: spec.branch, path },
      exec: async (command, o) => sh(command, path, o?.timeoutMs, await authEnv(o?.auth)),
      launch: (argv) => launch(argv, path),
      destroy: () => rm(root, { recursive: true, force: true }),
    };
  }
}
