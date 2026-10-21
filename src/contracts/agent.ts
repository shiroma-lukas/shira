import { z } from "zod";
import { Budget, Role } from "./common.js";
import { lintPermissions, Permission } from "./permissions.js";

export const API_VERSION = "shira/v1" as const;

/**
 * Who serves the tokens. The harness talks to the provider; the platform supplies its
 * credential and opens egress to it only for agents that use it.
 */
export const Provider = z.enum(["anthropic", "openrouter"]);
export type Provider = z.infer<typeof Provider>;

export const ModelChoice = z.object({
  harness: z.string().min(1),
  /** Model id as the provider names it, e.g. `claude-sonnet-5-5` or `z-ai/glm-5.3-flash`. */
  model: z.string().min(1),
  provider: Provider.default("anthropic"),
});
export type ModelChoice = z.infer<typeof ModelChoice>;

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
