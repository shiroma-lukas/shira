import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { EgressGrants } from "../egress/proxy.js";
import { launch, run } from "./process.js";
import {
  ATTACHMENT_NAME,
  type ExecResult,
  type RepoAccess,
  type RepoCredentials,
  type Sandbox,
  type SandboxProvider,
  type SandboxSpec,
} from "./sandbox.js";

/** Hosts every sandbox may reach: the model API and the code host. Repos add their own (FR-E4). */
export const DEFAULT_EGRESS = ["api.anthropic.com", "github.com", "*.githubusercontent.com"];

const WORKDIR = "/workspace/repo";
const REFS_DIR = "/workspace/refs";
/** Attachments travel as one environment variable; Linux caps a single one at 128 KiB. */
const MAX_ATTACHMENT_CHARS = 100_000;

export interface DockerSandboxOptions {
  /** gVisor's runtime name. Anything else drops kernel isolation and must be explicit. */
  runtime: "runsc" | { unsafe: string };
  /** A Docker network with no route to the internet (`docker network create --internal`). */
  network: string;
  /**
   * The egress proxy, e.g. `http://shira-egress:3128`. A hostname must be the proxy
   * container's name: Docker's embedded DNS doesn't work under gVisor, so the provider
   * looks up the container's address and writes it to the sandbox's /etc/hosts.
   */
  proxyUrl: string;
  egress: EgressGrants;
  credentials?: RepoCredentials;
  /** Variables the harness needs (e.g. ANTHROPIC_API_KEY), passed to launched processes only. */
  harnessEnv?: Record<string, string>;
  /** Overrides where to clone from (tests). */
  cloneUrl?: (repo: string) => string;
  /** Extra `docker run` arguments (tests: bind-mounting a local origin). */
  extraRunArgs?: string[];
  docker?: string;
}

/**
 * One gVisor container per task (FR-E1, FR-E2). gVisor gives each sandbox its own
 * user-space kernel; on top of that the container drops all capabilities, can't gain
 * privileges, has CPU, memory, and process limits, and sits on an internal network
 * whose only exit is the egress proxy with a per-sandbox allowlist.
 *
 * Secrets reach `docker` through its environment (`-e NAME` with no value), so they
 * never appear in argv on the host.
 */
export class DockerSandboxProvider implements SandboxProvider {
  private readonly docker: string;

  constructor(private readonly opts: DockerSandboxOptions) {
    this.docker = opts.docker ?? "docker";
  }

  private dockerRun(args: string[], env: Record<string, string> = {}, timeoutMs?: number): Promise<ExecResult> {
    return run([this.docker, ...args], { env, timeoutMs });
  }

  private async must(args: string[], env?: Record<string, string>): Promise<string> {
    const r = await this.dockerRun(args, env);
    if (r.code !== 0) throw new Error(`docker ${args[0]} failed (${r.code}): ${r.stderr.trim().slice(-500)}`);
    return r.stdout.trim();
  }

  async create(spec: SandboxSpec): Promise<Sandbox> {
    const repo = spec.repo.repo;
    const name = `shira-${spec.taskId.slice(0, 8)}-${randomBytes(3).toString("hex")}`;
    const secret = randomBytes(24).toString("base64url");
    const runtime = typeof this.opts.runtime === "string" ? this.opts.runtime : this.opts.runtime.unsafe;
    const proxy = new URL(this.opts.proxyUrl);
    proxy.username = name;
    proxy.password = secret;
    const proxyEnv = { HTTPS_PROXY: proxy.href, https_proxy: proxy.href, HTTP_PROXY: proxy.href, http_proxy: proxy.href };
    const { limits } = spec.repo;

    const proxyHost = await this.proxyHostArgs(proxy.hostname);
    await this.opts.egress.grant(name, secret, [...DEFAULT_EGRESS, ...spec.repo.egress.allow]);
    try {
      await this.must(
        [
          "run",
          "--detach",
          "--name",
          name,
          "--runtime",
          runtime,
          "--network",
          this.opts.network,
          "--cpus",
          String(limits.cpus),
          "--memory",
          `${limits.memoryMb}m`,
          "--pids-limit",
          "1024",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--label",
          `shira.task=${spec.taskId}`,
          ...Object.keys(proxyEnv).flatMap((k) => ["--env", k]),
          "--env",
          "NO_PROXY=",
          // git otherwise sends proxy credentials only after a 407 challenge, retrying on
          // the same connection, which the proxy closes. Basic up front avoids the round trip.
          "--env",
          "GIT_HTTP_PROXY_AUTHMETHOD=basic",
          ...proxyHost,
          ...(this.opts.extraRunArgs ?? []),
          "--entrypoint",
          "sleep",
          spec.repo.image,
          "infinity",
        ],
        proxyEnv,
      );

      const url = this.opts.cloneUrl?.(repo) ?? this.opts.credentials?.cloneUrl(repo) ?? `https://github.com/${repo}.git`;
      const readEnv = await this.authEnv(repo, "read");
      const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
      const checkout = spec.checkpointSha
        ? `git fetch --quiet origin ${q(spec.branch)} && git checkout --quiet -B ${q(spec.branch)} ${q(spec.checkpointSha)}`
        : `git checkout --quiet -B ${q(spec.branch)} ${q(`origin/${spec.repo.defaultBranch}`)}`;
      const setup = await this.execIn(
        name,
        `git clone --quiet ${q(url)} ${WORKDIR} && cd ${WORKDIR} && ` +
          `git config user.name shira-worker && git config user.email shira-worker@localhost && git config credential.helper '' && ` +
          checkout,
        { env: readEnv, workdir: "/" },
      );
      if (setup.code !== 0) throw new Error(`sandbox setup failed: ${setup.stderr.trim().slice(-500)}`);
    } catch (err) {
      await this.destroy(name);
      throw err;
    }

    let launches = 0;
    return {
      id: name,
      workspace: { repo, branch: spec.branch, path: WORKDIR },
      exec: async (command, o) => this.execIn(name, command, { env: await this.authEnv(repo, o?.auth), timeoutMs: o?.timeoutMs }),
      launch: (argv) => {
        // `docker exec` clients don't forward signals. The harness runs as the leader of its
        // own session, so killing its process group also stops everything it started.
        // `env kill` runs the kill binary (procps); dash's builtin can't signal a process group.
        const pidfile = `/tmp/shira-launch-${++launches}.pid`;
        const env = this.opts.harnessEnv ?? {};
        return launch(
          [
            this.docker,
            "exec",
            ...Object.keys(env).flatMap((k) => ["--env", k]),
            "--workdir",
            WORKDIR,
            name,
            "setsid",
            "--wait",
            "sh",
            "-c",
            `echo $$ > ${pidfile}; exec "$@"`,
            "sh",
            ...argv,
          ],
          {
            env,
            kill: () => {
              const signal = (sig: string) =>
                this.dockerRun(["exec", name, "sh", "-c", `env kill -${sig} -- -"$(cat ${pidfile})" 2>/dev/null`]).catch(() => {});
              void signal("TERM");
              setTimeout(() => void signal("KILL"), 5000).unref();
            },
          },
        );
      },
      writeFile: async (file, content) => {
        if (!ATTACHMENT_NAME.test(file)) throw new Error(`invalid attachment name ${file}`);
        const body = content.length > MAX_ATTACHMENT_CHARS ? `${content.slice(0, MAX_ATTACHMENT_CHARS)}\n[truncated]` : content;
        const r = await this.execIn(name, `mkdir -p ${REFS_DIR} && printf '%s' "$SHIRA_ATTACHMENT" > ${REFS_DIR}/${file}`, {
          env: { SHIRA_ATTACHMENT: body },
          workdir: "/",
        });
        if (r.code !== 0) throw new Error(`writing attachment ${file} failed: ${r.stderr.trim().slice(-300)}`);
        return `${REFS_DIR}/${file}`;
      },
      destroy: () => this.destroy(name),
    };
  }

  /** `--add-host` for the proxy container, looked up on the sandbox network. */
  private async proxyHostArgs(host: string): Promise<string[]> {
    if (isIP(host)) return [];
    const ip = await this.must([
      "inspect",
      "--format",
      `{{with index .NetworkSettings.Networks "${this.opts.network}"}}{{.IPAddress}}{{end}}`,
      host,
    ]);
    if (!isIP(ip)) throw new Error(`egress proxy container ${host} is not on network ${this.opts.network}`);
    return ["--add-host", `${host}:${ip}`];
  }

  private async authEnv(repo: string, access: RepoAccess | undefined): Promise<Record<string, string>> {
    return access && this.opts.credentials ? this.opts.credentials.gitEnv(repo, access) : {};
  }

  /** Runs a shell command in the container, with `env` passed by name and a hard timeout inside it. */
  private execIn(
    name: string,
    command: string,
    o: { env?: Record<string, string>; timeoutMs?: number; workdir?: string } = {},
  ): Promise<ExecResult> {
    const env = o.env ?? {};
    const seconds = Math.ceil((o.timeoutMs ?? 10 * 60_000) / 1000);
    return this.dockerRun(
      [
        "exec",
        ...Object.keys(env).flatMap((k) => ["--env", k]),
        "--workdir",
        o.workdir ?? WORKDIR,
        name,
        "timeout",
        "-s",
        "KILL",
        String(seconds),
        "sh",
        "-c",
        command,
      ],
      env,
      (seconds + 30) * 1000,
    );
  }

  private async destroy(name: string): Promise<void> {
    await this.dockerRun(["rm", "--force", name]);
    await this.opts.egress.revoke(name);
  }
}
