import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, sh } from "./process.js";
import { ATTACHMENT_NAME, type RepoCredentials, type Sandbox, type SandboxProvider, type SandboxSpec } from "./sandbox.js";

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
      launch: (argv) => launch(argv, { cwd: path, env: spec.harness?.env }),
      async writeFile(name, content) {
        if (!ATTACHMENT_NAME.test(name)) throw new Error(`invalid attachment name ${name}`);
        await mkdir(join(root, "refs"), { recursive: true });
        const file = join(root, "refs", name);
        await writeFile(file, content);
        return file;
      },
      destroy: () => rm(root, { recursive: true, force: true }),
    };
  }
}
