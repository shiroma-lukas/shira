import { createSign } from "node:crypto";
import type { CodeHost, Issue, IssueTracker, PullRequestInfo, PullRequests, Review, ReviewComment } from "../dispatcher/pr.js";
import type { ContextChanges } from "../decisions/decisions.js";
import type { RepoAccess, RepoCredentials } from "../sandbox/sandbox.js";

/** Installation token permissions per access level. Nothing beyond what the platform needs. */
type TokenPurpose = RepoAccess | "pull_request" | "reviews" | "issues";

const PERMISSIONS: Record<TokenPurpose, Record<string, "read" | "write">> = {
  read: { contents: "read" },
  write: { contents: "write" },
  // GitHub needs to read the head and base refs to open a PR ("not all refs are readable"
  // otherwise). contents: read still can't push or merge.
  pull_request: { pull_requests: "write", contents: "read" },
  issues: { issues: "write" },
  reviews: { pull_requests: "read" },
};

/** Refresh tokens this long before GitHub expires them (they live one hour). */
const REFRESH_MARGIN_MS = 5 * 60_000;

export interface GitHubAppOptions {
  appId: string;
  /** PEM private key generated for the GitHub App. */
  privateKey: string;
  apiUrl?: string;
  /** Git host used for clone and push URLs. */
  gitUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class GitHubError extends Error {
  constructor(
    method: string,
    path: string,
    readonly status: number,
    body: string,
  ) {
    super(`GitHub ${method} ${path} failed: ${status} ${body}`);
  }

  /** Retrying can't fix these: bad credentials, missing permission, missing resource, invalid request. */
  get permanent(): boolean {
    return [401, 403, 404, 422].includes(this.status);
  }
}

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/**
 * Repository access through a GitHub App (FR-E3). Every token is an installation
 * token scoped to one repository and the minimum permissions for the job, so a task
 * can never touch another repo, and only the platform ever holds write access.
 */
export class GitHubApp implements CodeHost, IssueTracker, RepoCredentials, PullRequests, ContextChanges {
  private readonly api: string;
  private readonly git: string;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly installations = new Map<string, number>();
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(private readonly opts: GitHubAppOptions) {
    this.api = (opts.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.git = (opts.gitUrl ?? "https://github.com").replace(/\/$/, "");
    this.fetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** Short-lived JWT that authenticates as the App itself (RS256, max 10 minutes). */
  appJwt(): string {
    const iat = Math.floor(this.now() / 1000) - 60; // tolerate clock drift
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = b64url(JSON.stringify({ iat, exp: iat + 9 * 60, iss: this.opts.appId }));
    const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(this.opts.privateKey);
    return `${header}.${payload}.${b64url(signature)}`;
  }

  private async request<T>(method: string, path: string, auth: string, body?: unknown): Promise<T> {
    const res = await this.fetch(`${this.api}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: auth,
        "x-github-api-version": "2022-11-28",
        "user-agent": "shira",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new GitHubError(method, path, res.status, (await res.text()).slice(0, 500));
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  private async installationId(repo: string): Promise<number> {
    const cached = this.installations.get(repo);
    if (cached) return cached;
    const { id } = await this.request<{ id: number }>("GET", `/repos/${repo}/installation`, `Bearer ${this.appJwt()}`);
    this.installations.set(repo, id);
    return id;
  }

  /** An installation token for one repo with one permission set, cached until near expiry. */
  async token(repo: string, purpose: TokenPurpose): Promise<string> {
    const key = `${repo}:${purpose}`;
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - REFRESH_MARGIN_MS > this.now()) return cached.token;

    const installation = await this.installationId(repo);
    const { token, expires_at } = await this.request<{ token: string; expires_at: string }>(
      "POST",
      `/app/installations/${installation}/access_tokens`,
      `Bearer ${this.appJwt()}`,
      { repositories: [repo.split("/")[1]], permissions: { metadata: "read", ...PERMISSIONS[purpose] } },
    );
    this.tokens.set(key, { token, expiresAt: Date.parse(expires_at) });
    return token;
  }

  /**
   * Revokes every installation token this process holds (kill switch, FR-S4). They would
   * otherwise stay valid for up to an hour. New tokens are minted on the next request.
   */
  async revokeTokens(): Promise<number> {
    const held = [...this.tokens.values()].filter((t) => t.expiresAt > this.now());
    this.tokens.clear();
    const results = await Promise.allSettled(held.map((t) => this.request("DELETE", "/installation/token", `token ${t.token}`)));
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length) throw new Error(`revoking ${failed.length} of ${held.length} tokens failed: ${(failed[0] as PromiseRejectedResult).reason}`);
    return held.length;
  }

  cloneUrl(repo: string): string {
    return `${this.git}/${repo}.git`;
  }

  /**
   * Git config entries that authenticate HTTPS git operations against the host. Passed
   * to git through GIT_CONFIG_* environment variables, so the token never appears in
   * argv or .git/config where the agent could read it later.
   */
  async gitEnv(repo: string, access: RepoAccess): Promise<Record<string, string>> {
    const basic = Buffer.from(`x-access-token:${await this.token(repo, access)}`).toString("base64");
    return {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `http.${this.git}/.extraheader`,
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    };
  }

  /**
   * Opens the PR, or returns the open one for the same branch. A retry after a crash
   * between opening the PR and marking the task done must not fail or duplicate it.
   */
  async openPullRequest(pr: { repo: string; head: string; base: string; title: string; body: string }) {
    const token = await this.token(pr.repo, "pull_request");
    try {
      const created = await this.request<{ number: number; html_url: string }>("POST", `/repos/${pr.repo}/pulls`, `token ${token}`, {
        title: pr.title,
        head: pr.head,
        base: pr.base,
        body: pr.body,
        maintainer_can_modify: true,
      });
      return { number: created.number, url: created.html_url };
    } catch (err) {
      if (!(err instanceof GitHubError && err.status === 422)) throw err;
      const owner = pr.repo.split("/")[0];
      const open = await this.request<{ number: number; html_url: string }[]>(
        "GET",
        `/repos/${pr.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${pr.head}`)}`,
        `token ${token}`,
      );
      if (!open[0]) throw err;
      return { number: open[0].number, url: open[0].html_url };
    }
  }

  /**
   * Proposes file changes to a repo as a PR from `branch` (context repo changes, FR-C4).
   * Never touches `base` itself. Safe to repeat: an existing branch is reused, files are
   * updated in place, and an open PR for the branch is returned.
   */
  async proposeChange(change: {
    repo: string;
    base: string;
    branch: string;
    files: { path: string; content: string }[];
    title: string;
    body: string;
  }): Promise<{ number: number; url: string }> {
    const write = `token ${await this.token(change.repo, "write")}`;
    const { object } = await this.request<{ object: { sha: string } }>("GET", `/repos/${change.repo}/git/ref/heads/${change.base}`, write);
    try {
      await this.request("POST", `/repos/${change.repo}/git/refs`, write, { ref: `refs/heads/${change.branch}`, sha: object.sha });
    } catch (err) {
      if (!(err instanceof GitHubError && err.status === 422)) throw err; // branch exists: a retry
    }
    for (const f of change.files) {
      const path = f.path.split("/").map(encodeURIComponent).join("/");
      let sha: string | undefined;
      try {
        sha = (await this.request<{ sha: string }>("GET", `/repos/${change.repo}/contents/${path}?ref=${encodeURIComponent(change.branch)}`, write)).sha;
      } catch (err) {
        if (!(err instanceof GitHubError && err.status === 404)) throw err;
      }
      await this.request("PUT", `/repos/${change.repo}/contents/${path}`, write, {
        message: change.title,
        content: Buffer.from(f.content).toString("base64"),
        branch: change.branch,
        ...(sha ? { sha } : {}),
      });
    }
    return this.openPullRequest({ repo: change.repo, head: change.branch, base: change.base, title: change.title, body: change.body });
  }

  async getIssue(repo: string, number: number): Promise<Issue> {
    const token = await this.token(repo, "issues");
    const i = await this.request<{
      number: number;
      title: string;
      body: string | null;
      state: "open" | "closed";
      html_url: string;
      pull_request?: unknown;
      user?: { login: string } | null;
      author_association?: string;
    }>(
      "GET",
      `/repos/${repo}/issues/${number}`,
      `token ${token}`,
    );
    if (i.pull_request) throw new Error(`${repo}#${number} is a pull request, not an issue`);
    return {
      number: i.number,
      title: i.title,
      body: i.body ?? "",
      state: i.state,
      url: i.html_url,
      ...(i.user ? { author: `@${i.user.login} (${i.author_association ?? "unknown"})` } : {}),
    };
  }

  async getPullRequest(repo: string, number: number): Promise<PullRequestInfo> {
    const token = await this.token(repo, "reviews");
    const p = await this.request<{ number: number; state: "open" | "closed"; html_url: string; head: { ref: string; sha: string } }>(
      "GET",
      `/repos/${repo}/pulls/${number}`,
      `token ${token}`,
    );
    return { number: p.number, state: p.state, url: p.html_url, head: { ref: p.head.ref, sha: p.head.sha } };
  }

  async listReviews(repo: string, number: number): Promise<Review[]> {
    const token = await this.token(repo, "reviews");
    const reviews = await this.request<
      { id: number; user: { login: string } | null; author_association: string; state: Review["state"]; body: string | null; html_url: string }[]
    >("GET", `/repos/${repo}/pulls/${number}/reviews?per_page=100`, `token ${token}`);
    return reviews.map((r) => ({
      id: r.id,
      author: r.user?.login ?? "ghost",
      association: r.author_association,
      state: r.state,
      body: r.body ?? "",
      url: r.html_url,
    }));
  }

  async reviewComments(repo: string, number: number, reviewId: number): Promise<ReviewComment[]> {
    const token = await this.token(repo, "reviews");
    const comments = await this.request<{ path: string; line: number | null; body: string; diff_hunk: string }[]>(
      "GET",
      `/repos/${repo}/pulls/${number}/reviews/${reviewId}/comments?per_page=100`,
      `token ${token}`,
    );
    return comments.map((c) => ({ path: c.path, line: c.line, body: c.body, diffHunk: c.diff_hunk }));
  }

  async comment(repo: string, number: number, body: string): Promise<void> {
    const token = await this.token(repo, "issues");
    await this.request("POST", `/repos/${repo}/issues/${number}/comments`, `token ${token}`, { body });
  }
}
