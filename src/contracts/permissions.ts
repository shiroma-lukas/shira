import { z } from "zod";
import type { Role } from "./common.js";

export const Permission = z.enum(["read", "branch", "open_pr", "comment", "message", "merge", "deploy"]);
export type Permission = z.infer<typeof Permission>;

/** Never grantable in v1: merge and deploy stay human actions (FR-S1). */
export const FORBIDDEN_IN_V1: ReadonlySet<Permission> = new Set(["merge", "deploy"]);

/**
 * The most each role may ever be granted (FR-S1). Agent definitions can narrow
 * this, never widen it. Lives in code so config cannot loosen policy (FR-S3).
 */
export const ROLE_PERMISSION_CEILING: Record<Role, readonly Permission[]> = {
  concierge: ["read", "comment", "message"],
  orchestrator: ["read"],
  architect: ["read", "branch", "open_pr", "comment", "message"],
  planner: ["read"],
  worker: ["read", "branch", "open_pr", "comment"],
  reviewer: ["read", "comment"],
  librarian: ["read", "branch", "open_pr", "comment"],
};

/** Permissions that only make sense alongside another one. */
const REQUIRES: Partial<Record<Permission, Permission>> = {
  branch: "read",
  open_pr: "branch",
  comment: "read",
};

/** Returns human-readable problems; an empty list means the grant is valid. */
export function lintPermissions(role: Role, granted: readonly Permission[]): string[] {
  const problems: string[] = [];
  const set = new Set(granted);
  const ceiling = new Set(ROLE_PERMISSION_CEILING[role]);
  for (const p of set) {
    if (FORBIDDEN_IN_V1.has(p)) problems.push(`${p} is not grantable in v1`);
    else if (!ceiling.has(p)) problems.push(`${role} may not be granted ${p}`);
    const needs = REQUIRES[p];
    if (needs && !set.has(needs)) problems.push(`${p} requires ${needs}`);
  }
  if (set.size !== granted.length) problems.push("duplicate permissions");
  return problems;
}
