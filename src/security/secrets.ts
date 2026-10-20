/**
 * Secret detection for diffs (FR-S2) and redaction for transcripts and logs (FR-L3).
 * Patterns favor precision: a false positive fails a task, so each one targets a
 * well-known credential format rather than generic entropy.
 */
const PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: "private key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g },
  { name: "AWS access key id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g },
  { name: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "OpenAI API key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { name: "Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "Stripe secret key", re: /\b[rs]k_live_[0-9A-Za-z]{24,}\b/g },
  { name: "URL with password", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]{3,}@[^\s/]+/gi },
];

export interface SecretFinding {
  pattern: string;
  /** 1-based line in the scanned text. */
  line: number;
}

/**
 * Scans a unified diff and reports secrets on added lines only, so removing a leaked
 * key is never blocked.
 */
export function scanDiff(diff: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  diff.split("\n").forEach((text, i) => {
    if (!text.startsWith("+") || text.startsWith("+++")) return;
    for (const { name, re } of PATTERNS) {
      re.lastIndex = 0;
      if (re.test(text)) findings.push({ pattern: name, line: i + 1 });
    }
  });
  return findings;
}

/** Replaces every match with a marker naming what was removed. */
export function redact(text: string): string {
  let out = text;
  for (const { name, re } of PATTERNS) out = out.replace(re, `[REDACTED ${name}]`);
  return out;
}
