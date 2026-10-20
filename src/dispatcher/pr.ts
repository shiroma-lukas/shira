import type { Spend } from "../ledger/ledger.js";
import type { Task } from "../queue/store.js";

/** Opens pull requests on the code host. Production: GitHub App (FR-E3). */
export interface CodeHost {
  openPullRequest(pr: { repo: string; head: string; base: string; title: string; body: string }): Promise<{
    number: number;
    url: string;
  }>;
}

export interface PrDescriptionInput {
  task: Task;
  summary: string;
  testCommand: string;
  testAttempts: number;
  diffStat: string;
  spend: Spend;
  runs: number;
}

/** First line of the goal, trimmed to a reasonable PR title length. */
export function prTitle(task: Task): string {
  const first = task.goal.split("\n")[0]!.trim();
  return first.length > 72 ? `${first.slice(0, 69)}...` : first;
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
    i.summary,
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
    `Task \`${t.id}\` requested by ${t.requester}. Opened by Agent Team Platform; merging is a human decision.`,
  ].join("\n");
}
