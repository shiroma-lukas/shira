import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { relative, resolve } from "node:path";
import type { LoadedConfig } from "../config/load.js";
import type { Db } from "../db/client.js";
import { Dispatcher } from "../dispatcher/dispatcher.js";
import { GitHubApp } from "../github/app.js";
import { ClaudeCodeAdapter } from "../harness/claude-code.js";
import { FileTranscriptStore } from "../harness/transcripts.js";
import { LocalSandboxProvider } from "../sandbox/local.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/** Reads a role's instructions from the context repo, refusing paths that escape it. */
function contextLoader(dir: string) {
  const root = resolve(dir);
  return async (path: string) => {
    const file = resolve(root, path);
    if (relative(root, file).startsWith("..")) throw new Error(`instructions path ${path} escapes the context repo`);
    return readFile(file, "utf8");
  };
}

/**
 * Runs a dispatcher with the real GitHub App and Claude Code, on the local sandbox.
 * The local sandbox has no isolation, so this is for trying Shira on your own repos
 * only, until the gVisor provider lands.
 */
export async function runDispatcher(db: Db, config: LoadedConfig, signal: AbortSignal): Promise<void> {
  const github = new GitHubApp({
    appId: required("SHIRA_GITHUB_APP_ID"),
    privateKey: await readFile(required("SHIRA_GITHUB_PRIVATE_KEY_PATH"), "utf8"),
  });
  required("ANTHROPIC_API_KEY"); // Claude Code runs with --bare, which ignores interactive logins.

  const dispatcher = new Dispatcher({
    db,
    config,
    adapters: new Map([
      ["claude-code", new ClaudeCodeAdapter({ transcripts: new FileTranscriptStore(process.env.SHIRA_TRANSCRIPTS_DIR ?? ".shira/transcripts") })],
    ]),
    sandboxes: new LocalSandboxProvider({ unsafeNoIsolation: true, credentials: github }),
    codeHost: github,
    instructions: contextLoader(process.env.SHIRA_CONTEXT_DIR ?? "context-template"),
    owner: `dispatcher-${hostname()}-${process.pid}`,
    log: (m, f) => console.log(new Date().toISOString(), m, f ? JSON.stringify(f) : ""),
  });
  console.log("dispatcher running (local sandbox, NO isolation). Ctrl-C stops after the current task.");
  await dispatcher.run(signal);
}
