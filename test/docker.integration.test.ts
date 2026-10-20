// Runs the Docker sandbox for real. Skipped unless SHIRA_TEST_DOCKER=1. Uses gVisor
// (runsc) by default; set SHIRA_TEST_DOCKER_RUNTIME=runc on hosts without gVisor (macOS)
// to exercise everything except the kernel isolation itself.
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RepoConfig } from "../src/contracts/index.js";
import { EgressAdminClient } from "../src/egress/proxy.js";
import { DockerSandboxProvider } from "../src/sandbox/docker.js";
import { run } from "../src/sandbox/process.js";
import type { Sandbox } from "../src/sandbox/sandbox.js";
import { makeOrigin } from "./fakes.js";

const enabled = process.env.SHIRA_TEST_DOCKER === "1";
const runtime = process.env.SHIRA_TEST_DOCKER_RUNTIME ?? "runsc";
const IMAGE = "node:22-bookworm"; // has git, curl, and coreutils timeout
const id = randomBytes(3).toString("hex");
const network = `shira-test-net-${id}`;
const proxyName = `shira-test-egress-${id}`;
const token = randomBytes(24).toString("hex");

async function docker(...args: string[]): Promise<string> {
  const r = await run(["docker", ...args], { timeoutMs: 600_000 });
  if (r.code !== 0) throw new Error(`docker ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

describe.skipIf(!enabled)(`Docker sandbox (${runtime})`, () => {
  let sandbox: Sandbox;
  let provider: DockerSandboxProvider;

  beforeAll(async () => {
    const r = await run(["pnpm", "-s", "build:egress"]);
    if (r.code !== 0) throw new Error(r.stderr);
    await docker("pull", "--quiet", IMAGE);
    await docker("network", "create", "--internal", network);
    await docker(
      "run", "--detach", "--name", proxyName,
      "--env", `SHIRA_EGRESS_ADMIN_TOKEN=${token}`,
      "--publish", "127.0.0.1::8080",
      "--volume", `${fileURLToPath(new URL("../dist", import.meta.url))}:/app:ro`,
      IMAGE, "node", "/app/egress-proxy.mjs",
    );
    await docker("network", "connect", network, proxyName);
    const adminPort = (await docker("port", proxyName, "8080/tcp")).split(":").at(-1);
    const admin = new EgressAdminClient(`http://127.0.0.1:${adminPort}`, token);
    for (let i = 0; i < 50; i++) {
      try {
        await admin.revoke("warmup");
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    const origin = await makeOrigin();
    const bundleDir = await mkdtemp(join(tmpdir(), "shira-bundle-"));
    const bundled = await run(["git", "-C", origin, "bundle", "create", join(bundleDir, "origin.bundle"), "--all"]);
    if (bundled.code !== 0) throw new Error(bundled.stderr);
    // The container's root has every capability dropped, including the one that bypasses
    // file permissions, so the bundle must be world-readable.
    await chmod(bundleDir, 0o755);
    await chmod(join(bundleDir, "origin.bundle"), 0o644);
    provider = new DockerSandboxProvider({
      runtime: runtime === "runsc" ? "runsc" : { unsafe: runtime },
      network,
      proxyUrl: `http://${proxyName}:3128`,
      egress: admin,
      // Clone from a bundle: on Linux a bind-mounted repo belongs to the CI user, not the
      // container's root, and git refuses to read repos owned by someone else.
      cloneUrl: () => "/origin/origin.bundle",
      extraRunArgs: ["--volume", `${bundleDir}:/origin:ro`],
      harnessEnv: { SHIRA_TEST_SECRET: "visible-to-harness-only" },
    });
    const repo = RepoConfig.parse({
      apiVersion: "shira/v1",
      kind: "Repo",
      repo: "acme/web",
      image: IMAGE,
      test: "true",
      egress: { allow: ["registry.npmjs.org"] },
    });
    sandbox = await provider.create({ taskId: "abcdef12-0000-4000-8000-000000000000", repo, branch: "shira/abcdef12" });
  }, 600_000);

  afterAll(async () => {
    await sandbox?.destroy();
    await run(["docker", "rm", "--force", proxyName]);
    await run(["docker", "network", "rm", network]);
  });

  it("clones the repo onto the task branch", async () => {
    const r = await sandbox.exec("git rev-parse --abbrev-ref HEAD && cat app.txt");
    expect(r.stdout.trim().split("\n")).toEqual(["shira/abcdef12", "broken"]);
  });

  it("uses the configured runtime with capabilities dropped", async () => {
    const inspect = JSON.parse(await docker("inspect", sandbox.id))[0];
    expect(inspect.HostConfig.Runtime).toBe(runtime);
    expect(inspect.HostConfig.CapDrop).toContain("ALL");
    expect(inspect.HostConfig.SecurityOpt).toContain("no-new-privileges");
  });

  it("reaches allowlisted hosts through the proxy", async () => {
    const r = await sandbox.exec("curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://registry.npmjs.org/");
    expect(r.code).toBe(0);
    expect(Number(r.stdout)).toBeLessThan(500);
  }, 60_000);

  it("lets git reach GitHub through the proxy", async () => {
    const r = await sandbox.exec("git ls-remote --heads https://github.com/octocat/Hello-World.git");
    expect(r.stderr).toBe("");
    expect(r.stdout).toMatch(/refs\/heads\/master/);
  }, 60_000);

  it("is refused by the proxy for other hosts", async () => {
    const r = await sandbox.exec("curl -sS -o /dev/null --max-time 20 https://example.com/");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/403/);
  }, 60_000);

  it("cannot bypass the proxy, including to the metadata endpoint", async () => {
    const direct = await sandbox.exec("curl -sS --noproxy '*' --max-time 5 https://example.com/");
    expect(direct.code).not.toBe(0);
    const metadata = await sandbox.exec("curl -sS --noproxy '*' --max-time 5 http://169.254.169.254/");
    expect(metadata.code).not.toBe(0);
  }, 60_000);

  it("gives harness variables to launched processes only", async () => {
    const proc = sandbox.launch(["sh", "-c", 'echo "secret=$SHIRA_TEST_SECRET"']);
    const lines: string[] = [];
    for await (const l of proc.lines) lines.push(l);
    expect(lines).toEqual(["secret=visible-to-harness-only"]);
    expect((await sandbox.exec('echo "secret=$SHIRA_TEST_SECRET"')).stdout.trim()).toBe("secret=");
  });

  it("kills a launched process inside the container", async () => {
    const proc = sandbox.launch(["sh", "-c", "echo started; sleep 300"]);
    const it = proc.lines[Symbol.asyncIterator]();
    expect((await it.next()).value).toBe("started");
    const t0 = Date.now();
    proc.kill();
    await proc.exited;
    expect(Date.now() - t0).toBeLessThan(10_000);
    // The child (`sleep 300`) must die with the harness, not linger as an orphan.
    const survivors = await sandbox.exec(
      "for i in 1 2 3 4 5 6 7 8 9 10; do pgrep -fx 'sleep 300' >/dev/null || break; sleep 0.2; done; pgrep -fx 'sleep 300' || true",
    );
    expect(survivors.stdout.trim()).toBe("");
  }, 30_000);

  it("removes the container on destroy", async () => {
    const extra = await provider.create({
      taskId: "fedcba98-0000-4000-8000-000000000000",
      repo: RepoConfig.parse({ apiVersion: "shira/v1", kind: "Repo", repo: "acme/web", image: IMAGE, test: "true" }),
      branch: "shira/fedcba98",
    });
    await extra.destroy();
    expect(await docker("ps", "--all", "--quiet", "--filter", `name=${extra.id}`)).toBe("");
  }, 120_000);
});
