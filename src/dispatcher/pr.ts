import type { Spend } from "../ledger/ledger.js";
import type { Task } from "../queue/store.js";
import { neutralizeForGitHub } from "../security/untrusted.js";

/** Opens pull requests on the code host. Production: GitHub App (FR-E3). */
export interface CodeHost {
  openPullRequest(pr: { repo: string; head: string; base: string; title: string; body: string }): Promise<{
    number: number;
    url: string;
  }>;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  url: string;
  /** "@login (ASSOCIATION)", e.g. "@octocat (NONE)": shown to the agent next to the untrusted text. */
  author?: string;
}

/** Reads and comments on issues. Production: the GitHub App (needs Issues: read and write). */
export interface IssueTracker {
  getIssue(repo: string, number: number): Promise<Issue>;
  comment(repo: string, number: number, body: string): Promise<void>;
}

/** Parses a GitHub thread ref id, "org/name#12". */
export function parseIssueRef(id: string): { repo: string; number: number } | null {
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(id);
  return m ? { repo: m[1]!, number: Number(m[2]) } : null;
}

export interface PrDescriptionInput {
  task: Task;
  summary: string;
  /** Issue number this PR resolves; adds a closing keyword so merging closes it. */
  closes?: number;
  testCommand: string;
  testAttempts: number;
  diffStat: string;
  spend: Spend;
  runs: number;
}

/** The agent's title when it gave one, else the goal's first sentence, trimmed to PR title length. */
export function prTitle(task: Task, agentTitle?: string): string {
  const source = neutralizeForGitHub(agentTitle?.trim() || task.goal.split(/\n|(?<=\.)\s/)[0]!.trim());
  const title = source.replace(/\.$/, "");
  return title.length > 72 ? `${title.slice(0, 69)}...` : title;
}

/**
 * Standard PR description (FR-H4): summary, linked decision, risk, verification
 * evidence, and cost. Risk is "unassessed" until the reviewer agent ships (M3).
 */
export function prDescription(i: PrDescriptionInput): string {
  const t = i.task;
  return [
    "## Summary",
    "",
    // The agent's words may echo untrusted input: they must not close issues or ping anyone.
    neutralizeForGitHub(i.summary),
    ...(i.closes ? ["", `Fixes #${i.closes}`] : []),
    "",
    "## Decision",
    "",
    t.decisionId ? `Implements ${t.decisionId}.` : "No linked decision (direct request).",
    "",
    "## Risk",
    "",
    "Unassessed (no reviewer agent yet). Review as a normal change.",
    "",
    "## Verification",
    "",
    `- Rebased on the latest default branch before opening.`,
    `- \`${i.testCommand}\` passed${i.testAttempts > 1 ? ` (on attempt ${i.testAttempts}, flaky retries allowed)` : ""}.`,
    `- Diff scanned for secrets: none found.`,
    "",
    "```",
    i.diffStat.trim(),
    "```",
    "",
    "## Cost",
    "",
    `$${i.spend.usd.toFixed(2)} of $${t.budget.usd} budget, ${i.spend.tokens.toLocaleString("en-US")} tokens, ` +
      `${i.spend.minutes.toFixed(1)} min across ${i.runs} run(s).`,
    "",
    "---",
    `Task \`${t.id}\` requested by ${t.requester}. Opened by Shira; merging is a human decision.`,
  ].join("\n");
}
