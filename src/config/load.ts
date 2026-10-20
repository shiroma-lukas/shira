import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import type { z } from "zod";
import { AgentDefinition, RepoConfig } from "../contracts/index.js";

export interface LoadedConfig {
  agents: AgentDefinition[];
  repos: RepoConfig[];
}

export interface ConfigError {
  file: string;
  message: string;
}

export type LoadResult = { ok: true; config: LoadedConfig } | { ok: false; errors: ConfigError[] };

async function yamlFiles(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir);
    return names.filter((n) => /\.ya?ml$/.test(n)).sort().map((n) => join(dir, n));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function loadAll<S extends z.ZodType>(dir: string, schema: S, errors: ConfigError[]) {
  const out: { file: string; value: z.infer<S> }[] = [];
  for (const file of await yamlFiles(dir)) {
    let raw: unknown;
    try {
      raw = parse(await readFile(file, "utf8"));
    } catch (err) {
      errors.push({ file, message: `invalid YAML: ${(err as Error).message}` });
      continue;
    }
    const parsed = schema.safeParse(raw);
    if (parsed.success) out.push({ file, value: parsed.data });
    else for (const issue of parsed.error.issues) errors.push({ file, message: `${issue.path.join(".") || "(root)"}: ${issue.message}` });
  }
  return out;
}

function flagDuplicates<T>(items: { file: string; value: T }[], key: (v: T) => string, what: string, errors: ConfigError[]) {
  const seen = new Map<string, string>();
  for (const { file, value } of items) {
    const k = key(value);
    const first = seen.get(k);
    if (first) errors.push({ file, message: `duplicate ${what} "${k}" (also defined in ${first})` });
    else seen.set(k, file);
  }
}

/** Loads and validates `<root>/agents/*.yaml` and `<root>/repos/*.yaml`. */
export async function loadConfig(root: string): Promise<LoadResult> {
  const errors: ConfigError[] = [];
  const agents = await loadAll(join(root, "agents"), AgentDefinition, errors);
  const repos = await loadAll(join(root, "repos"), RepoConfig, errors);
  // Envelopes address agents by role, so each role has exactly one definition.
  flagDuplicates(agents, (a) => a.role, "role", errors);
  flagDuplicates(repos, (r) => r.repo, "repo", errors);
  if (errors.length) return { ok: false, errors };
  return { ok: true, config: { agents: agents.map((a) => a.value), repos: repos.map((r) => r.value) } };
}
