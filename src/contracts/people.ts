import { z } from "zod";

/**
 * People and approval authority, kept in the context repo (FR-H2). The files are the
 * source of truth for who may approve what; the `identities` table mirrors them so
 * decision records can reference approvers.
 */

const IdentityId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "lowercase letters, digits, and dashes");

export const Risk = z.enum(["low", "medium", "high"]);
export type Risk = z.infer<typeof Risk>;
export const RISK_ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

export const Identity = z.object({
  id: IdentityId,
  name: z.string().min(1),
  /** GitHub login, without "@". */
  github: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/).optional(),
  /** Slack member id, e.g. U012ABCDEF. */
  slack: z.string().regex(/^[UW][A-Z0-9]{2,}$/).optional(),
  /** Roles approval rules can name, e.g. tech-lead, product. */
  roles: z.array(IdentityId).default([]),
});
export type Identity = z.infer<typeof Identity>;

/** `identities.yaml` in the context repo. */
export const IdentitiesFile = z.object({ identities: z.array(Identity) });

/**
 * One approval rule. A proposal is approvable by an identity when some rule names the
 * identity (or one of its roles) and covers the proposal's repo, risk, and estimated cost.
 */
export const ApprovalRule = z
  .object({
    /** Identity ids. */
    approvers: z.array(IdentityId).default([]),
    /** Identity roles; anyone holding one may approve. */
    approver_roles: z.array(IdentityId).default([]),
    /** Repos as org/name, or globs like org/*. */
    repos: z.array(z.string().min(1)).min(1),
    max_risk: Risk,
    max_estimated_usd: z.number().positive(),
  })
  .refine((r) => r.approvers.length + r.approver_roles.length > 0, "a rule needs approvers or approver_roles");
export type ApprovalRule = z.infer<typeof ApprovalRule>;

/** `approvals.yaml` in the context repo. */
export const ApprovalsFile = z.object({ rules: z.array(ApprovalRule) });

export const OwnershipEntry = z.object({
  identity: IdentityId,
  repos: z.array(z.string().min(1)).min(1),
  paths: z.array(z.string().min(1)).default(["**"]),
  contact: z.object({
    channel: z.enum(["slack", "github"]),
    urgent: z.enum(["dm", "channel", "none"]).default("dm"),
    digest: z.enum(["daily", "weekly", "none"]).default("daily"),
  }),
});
export type OwnershipEntry = z.infer<typeof OwnershipEntry>;

/** `ownership.yaml` in the context repo (FR-H6). */
export const OwnershipFile = z.object({ owners: z.array(OwnershipEntry) });

/** What an approval is checked against: a proposal (M2-E) or anything else needing sign-off. */
export interface ApprovalRequest {
  repo: string;
  risk: Risk;
  estimatedUsd: number;
}
