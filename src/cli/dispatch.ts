import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { relative, resolve } from "node:path";
import type { LoadedConfig } from "../config/load.js";
import type { Db } from "../db/client.js";
import { Dispatcher } from "../dispatcher/dispatcher.js";
import { GitHubApp } from "../github/app.js";
import { ClaudeCodeAdapter } from "../harness/claude-code.js";
import { harnessAccessFromEnv } from "../harness/providers.js";
import { OpenRouterPriceTable } from "../ledger/prices.js";
import { transcriptStoreFromEnv } from "../harness/transcripts.js";
import { EgressAdminClient } from "../egress/proxy.js";
import { DockerSandboxProvider } from "../sandbox/docker.js";
import { LocalSandboxProvider } from "../sandbox/local.js";
import type { SandboxProvider } from "../sandbox/sandbox.js";

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

export type SandboxMode = { kind: "docker"; unsafeRuntime: boolean } | { kind: "local-unsafe" };

function sandboxes(mode: SandboxMode, github: GitHubApp): SandboxProvider {
  if (mode.kind === "local-unsafe") return new LocalSandboxProvider({ unsafeNoIsolation: true, credentials: github });
  const runtime = process.env.SHIRA_SANDBOX_RUNTIME ?? "runsc";
  if (runtime !== "runsc" && !mode.unsafeRuntime) {
    throw new Error(`SHIRA_SANDBOX_RUNTIME=${runtime} drops gVisor isolation; pass --unsafe-runtime to confirm`);
  }
  return new DockerSandboxProvider({
    runtime: runtime === "runsc" ? "runsc" : { unsafe: runtime },
    network: process.env.SHIRA_SANDBOX_NETWORK ?? "shira-sandbox",
    proxyUrl: process.env.SHIRA_EGRESS_PROXY_URL ?? "http://shira-egress:3128",
    egress: new EgressAdminClient(process.env.SHIRA_EGRESS_ADMIN_URL ?? "http://127.0.0.1:8080", required("SHIRA_EGRESS_ADMIN_TOKEN")),
    credentials: github,
  });
}

export async function githubFromEnv(): Promise<GitHubApp> {
  return new GitHubApp({
    appId: required("SHIRA_GITHUB_APP_ID"),
    privateKey: await readFile(required("SHIRA_GITHUB_PRIVATE_KEY_PATH"), "utf8"),
  });
}

/** Runs a dispatcher with the real GitHub App and Claude Code. */
export async function runDispatcher(
  db: Db,
  config: LoadedConfig,
  mode: SandboxMode,
  signal: AbortSignal,
  concurrency = 1,
): Promise<void> {
  const github = await githubFromEnv();
  const log = (m: string, f?: Record<string, unknown>) => console.log(new Date().toISOString(), m, f ? JSON.stringify(f) : "");

  // Fail at startup, not per task, when a configured agent's provider has no credential.
  // Claude Code runs with --bare, which ignores interactive logins.
  const harnessAccess = harnessAccessFromEnv(process.env);
  for (const agent of config.agents) harnessAccess(agent.model.primary);

  const openRouterPrices = new OpenRouterPriceTable({ onError: (err) => log("price refresh failed", { error: err.message }) });
  if (config.agents.some((a) => a.model.primary.provider === "openrouter")) {
    // Without prices, runs are still recorded, with an unknown cost.
    await openRouterPrices.refresh().catch((err: Error) => log("price refresh failed", { error: err.message }));
  }

  const dispatcher = new Dispatcher({
    db,
    config,
    adapters: new Map([
      [
        "claude-code",
        new ClaudeCodeAdapter({
          transcripts: transcriptStoreFromEnv(process.env),
          prices: (provider, model) => (provider === "openrouter" ? openRouterPrices.lookup(model) : null),
        }),
      ],
    ]),
    sandboxes: sandboxes(mode, github),
    harnessAccess,
    codeHost: github,
    issues: github,
    instructions: contextLoader(process.env.SHIRA_CONTEXT_DIR ?? "context-template"),
    owner: `dispatcher-${hostname()}-${process.pid}`,
    log,
  });
  console.log(
    mode.kind === "local-unsafe"
      ? `dispatcher running on the local sandbox: NO isolation, concurrency ${concurrency}. Ctrl-C stops after the current tasks.`
      : `dispatcher running on Docker (${process.env.SHIRA_SANDBOX_RUNTIME ?? "runsc"}), concurrency ${concurrency}. Ctrl-C stops after the current tasks.`,
  );
  await dispatcher.run(signal, undefined, concurrency);
}
