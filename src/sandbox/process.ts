import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { HarnessProcess } from "../contracts/adapter.js";
import type { ExecResult } from "./sandbox.js";

const MAX_OUTPUT = 1_000_000;

export interface ProcessOptions {
  cwd?: string;
  /** Added to this process's environment. */
  env?: Record<string, string>;
}

/** Runs argv directly (no shell), capturing at most MAX_OUTPUT bytes of each stream. */
export function run(argv: string[], opts: ProcessOptions & { timeoutMs?: number } = {}): Promise<ExecResult> {
  const [cmd, ...args] = argv;
  if (!cmd) throw new Error("run needs a command");
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...opts.env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout = (stdout + d).slice(-MAX_OUTPUT)));
    child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d).slice(-MAX_OUTPUT)));
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 10 * 60_000);
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

/** Runs a shell command in `cwd`. */
export function sh(command: string, cwd: string, timeoutMs?: number, env?: Record<string, string>): Promise<ExecResult> {
  return run(["sh", "-c", command], { cwd, env, timeoutMs });
}

/**
 * Starts argv (no shell), streaming stdout by line. `kill` overrides how the process
 * is stopped, for runtimes where killing the local client doesn't stop the real
 * process (e.g. `docker exec`).
 */
export function launch(argv: string[], opts: ProcessOptions & { kill?: () => void } = {}): HarnessProcess {
  const [cmd, ...args] = argv;
  if (!cmd) throw new Error("launch needs a command");
  const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...opts.env } });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d).slice(-MAX_OUTPUT)));
  const exited = new Promise<{ code: number; stderr: string }>((resolve) => {
    child.on("error", (err) => resolve({ code: 127, stderr: `${stderr}${err.message}` }));
    child.on("close", (code, signal) => resolve({ code: code ?? (signal ? 137 : 1), stderr }));
  });
  return {
    lines: createInterface({ input: child.stdout, crlfDelay: Infinity }),
    exited,
    kill:
      opts.kill ??
      (() => {
        child.kill("SIGTERM");
        setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 5000).unref();
      }),
  };
}
