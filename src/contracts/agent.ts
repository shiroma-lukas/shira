import { z } from "zod";
import { Budget, Role } from "./common.js";
import { lintPermissions, Permission } from "./permissions.js";

export const API_VERSION = "atp/v1" as const;

const ModelChoice = z.object({
  harness: z.string().min(1),
  model: z.string().min(1),
});

/**
 * Declarative agent definition, stored as YAML in version control (FR-A1).
 * Changing model policy here takes effect without a code deploy (FR-A2).
 */
export const AgentDefinition = z
  .object({
    apiVersion: z.literal(API_VERSION),
    kind: z.literal("Agent"),
    role: Role,
    description: z.string().min(1),
    model: z.object({
      primary: ModelChoice,
      /** Tried in order when the primary is unavailable or rate limited. */
      fallbacks: z.array(ModelChoice).default([]),
    }),
    /** Tool ids the harness may expose to this agent. Unlisted tools are denied. */
    tools: z.array(z.string().min(1)).default([]),
    permissions: z.array(Permission),
    budget: Budget,
    /** Path in the context repo to the role's canonical instructions (FR-X4). */
    instructions: z.string().min(1),
  })
  .superRefine((def, ctx) => {
    for (const problem of lintPermissions(def.role, def.permissions)) {
      ctx.addIssue({ code: "custom", path: ["permissions"], message: problem });
    }
  });
export type AgentDefinition = z.infer<typeof AgentDefinition>;
