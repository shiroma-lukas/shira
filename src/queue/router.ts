import type { Role } from "../contracts/index.js";

export interface IntakeRequest {
  source: "cli" | "slack" | "github";
}

interface Rule {
  name: string;
  when: (r: IntakeRequest) => boolean;
  role: Role;
}

/**
 * Hard routing rules, checked in order (FR-O1). M1 only has CLI intake, and CLI
 * requests are concrete tasks, so they go straight to a worker. Chat routes to the
 * concierge from M2. The classifier comes after these rules in M4.
 */
const RULES: readonly Rule[] = [{ name: "cli-to-worker", when: (r) => r.source === "cli", role: "worker" }];

export interface Route {
  role: Role;
  rule: string;
}

/** Returns null when no rule matches; the caller escalates to a human. */
export function route(req: IntakeRequest): Route | null {
  const rule = RULES.find((r) => r.when(req));
  return rule ? { role: rule.role, rule: rule.name } : null;
}
