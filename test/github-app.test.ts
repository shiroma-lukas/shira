import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RepoConfig } from "../src/contracts/index.js";
import { GitHubApp } from "../src/github/app.js";
import { LocalSandboxProvider } from "../src/sandbox/local.js";
import type { RepoCredentials } from "../src/sandbox/sandbox.js";
import { makeOrigin } from "./fakes.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

type Call = { method: string; url: string; auth: string; body: unknown };

/** A fake GitHub API: routes by "METHOD path" and records every call. */
function fakeGitHub(routes: Record<string, (call: Call) => { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const call: Call = {
      method: init.method!,
      url: u.pathname + u.search,
      auth: (init.headers as Record<string, string>).authorization!,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    const route = routes[`${call.method} ${u.pathname}`];
    const { status = 200, body } = route ? route(call) : { status: 404, body: { message: "Not Found" } };
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const tokenRoutes = (expiresAt: () => string) => ({
  "GET /repos/acme/web/installation": () => ({ body: { id: 77 } }),
  "POST /app/installations/77/access_tokens": () => ({ status: 201, body: { token: `ghs_${Math.random()}`, expires_at: expiresAt() } }),
});

describe("GitHubApp", () => {
  it("signs a valid RS256 app JWT", () => {
    const now = Date.parse("2026-10-19T12:00:00Z");
    const jwt = new GitHubApp({ appId: "123", privateKey, now: () => now }).appJwt();
    const [h, p, sig] = jwt.split(".") as [string, string, string];
    const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(createPublicKey(publicKey), Buffer.from(sig, "base64url"));
    expect(ok).toBe(true);
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    expect(payload.iss).toBe("123");
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
    expect(payload.iat).toBeLessThan(now / 1000);
  });

  it("requests tokens scoped to one repo and minimal permissions, and caches them", async () => {
    const gh = fakeGitHub(tokenRoutes(() => new Date(Date.now() + 3600_000).toISOString()));
    const app = new GitHubApp({ appId: "123", privateKey, fetch: gh.fetchImpl });

    const t1 = await app.token("acme/web", "read");
    const t2 = await app.token("acme/web", "read");
    await app.token("acme/web", "write");

    expect(t1).toBe(t2);
    const issued = gh.calls.filter((c) => c.url.endsWith("/access_tokens"));
    expect(issued.map((c) => c.body)).toEqual([
      { repositories: ["web"], permissions: { metadata: "read", contents: "read" } },
      { repositories: ["web"], permissions: { metadata: "read", contents: "write" } },
    ]);
    expect(gh.calls.filter((c) => c.url.endsWith("/installation"))).toHaveLength(1);
    expect(issued[0]!.auth).toMatch(/^Bearer ey/);
  });

  it("revokes every token it holds, then mints new ones (kill switch)", async () => {
    const gh = fakeGitHub({
      ...tokenRoutes(() => new Date(Date.now() + 3600_000).toISOString()),
      "DELETE /installation/token": () => ({ status: 204, body: null }),
    });
    const app = new GitHubApp({ appId: "123", privateKey, fetch: gh.fetchImpl });
    const read = await app.token("acme/web", "read");
    const write = await app.token("acme/web", "write");

    expect(await app.revokeTokens()).toBe(2);
    const revoked = gh.calls.filter((c) => c.method === "DELETE").map((c) => c.auth);
    expect(revoked.sort()).toEqual([`token ${read}`, `token ${write}`].sort());
    expect(await app.token("acme/web", "read")).not.toBe(read);
    expect(await app.revokeTokens()).toBe(1);
  });

  it("refreshes a token close to expiry", async () => {
    let now = Date.parse("2026-10-19T12:00:00Z");
    const gh = fakeGitHub(tokenRoutes(() => new Date(now + 3600_000).toISOString()));
    const app = new GitHubApp({ appId: "123", privateKey, fetch: gh.fetchImpl, now: () => now });
    const first = await app.token("acme/web", "write");
    now += 56 * 60_000;
    expect(await app.token("acme/web", "write")).not.toBe(first);
  });

  it("opens a PR with a pull-request-only token", async () => {
    const gh = fakeGitHub({
      ...tokenRoutes(() => new Date(Date.now() + 3600_000).toISOString()),
      "POST /repos/acme/web/pulls": () => ({ status: 201, body: { number: 12, html_url: "https://github.com/acme/web/pull/12" } }),
    });
    const app = new GitHubApp({ appId: "123", privateKey, fetch: gh.fetchImpl });
    const pr = await app.openPullRequest({ repo: "acme/web", head: "shira/abc", base: "main", title: "Fix", body: "Body" });

    expect(pr).toEqual({ number: 12, url: "https://github.com/acme/web/pull/12" });
    const tokenCall = gh.calls.find((c) => c.url.endsWith("/access_tokens"))!;
    expect(tokenCall.body).toEqual({
      repositories: ["web"],
      permissions: { metadata: "read", pull_requests: "write", contents: "read" },
    });
    const prCall = gh.calls.find((c) => c.url === "/repos/acme/web/pulls")!;
    expect(prCall.auth).toMatch(/^token ghs_/);
    expect(prCall.body).toMatchObject({ head: "shira/abc", base: "main", title: "Fix", body: "Body" });
  });

  it("returns the existing PR when one is already open for the branch", async () => {
    const gh = fakeGitHub({
      ...tokenRoutes(() => new Date(Date.now() + 3600_000).toISOString()),
      "POST /repos/acme/web/pulls": () => ({ status: 422, body: { message: "A pull request already exists for acme:shira/abc." } }),
      "GET /repos/acme/web/pulls": () => ({ body: [{ number: 9, html_url: "https://github.com/acme/web/pull/9" }] }),
    });
    const app = new GitHubApp({ appId: "123", privateKey, fetch: gh.fetchImpl });
    const pr = await app.openPullRequest({ repo: "acme/web", head: "shira/abc", base: "main", title: "Fix", body: "" });
    expect(pr.number).toBe(9);
    expect(gh.calls.at(-1)!.url).toBe("/repos/acme/web/pulls?state=open&head=acme%3Ashira%2Fabc");
  });

  it("surfaces other API errors", async () => {
    const gh = fakeGitHub({});
    const app = new GitHubApp({ appId: "123", privateKey, fetch: gh.fetchImpl });
    await expect(app.token("acme/web", "read")).rejects.toThrow(/404/);
  });
});

describe("repo credentials in the sandbox", () => {
  it("authenticates platform git commands without leaving the token in the workspace", async () => {
    const origin = await makeOrigin();
    const seen: string[] = [];
    const credentials: RepoCredentials = {
      cloneUrl: () => origin,
      async gitEnv(_repo, access) {
        seen.push(access);
        return { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic secret-${access}` };
      },
    };
    const repo = RepoConfig.parse({ apiVersion: "shira/v1", kind: "Repo", repo: "acme/web", image: "none", test: "true" });
    const sandbox = await new LocalSandboxProvider({ unsafeNoIsolation: true, credentials }).create({ taskId: "t", repo, branch: "shira/t" });
    try {
      expect(seen).toEqual(["read"]); // the clone
      const authed = await sandbox.exec("git config --get http.https://github.com/.extraheader", { auth: "write" });
      expect(authed.stdout.trim()).toBe("AUTHORIZATION: basic secret-write");
      const plain = await sandbox.exec("git config --get http.https://github.com/.extraheader");
      expect(plain.code).not.toBe(0); // the agent's own commands get no credentials
      const gitConfig = await readFile(join(sandbox.workspace.path, ".git", "config"), "utf8");
      expect(gitConfig).not.toContain("secret");
      // An empty local helper resets helpers inherited from system and global config.
      const helper = await sandbox.exec("git config --local --get credential.helper");
      expect([helper.code, helper.stdout.trim()]).toEqual([0, ""]);
    } finally {
      await sandbox.destroy();
    }
  });
});
