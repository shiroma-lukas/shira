import type { ModelChoice, Provider } from "../contracts/index.js";
import type { HarnessAccess } from "../sandbox/sandbox.js";

/** What the platform needs to know to let a harness reach one provider. */
export interface ProviderSpec {
  /** Hosts the sandbox may reach for this provider, added only for agents that use it (FR-E4). */
  egress: readonly string[];
  /** Host environment variable holding the provider credential. */
  credentialEnv: string;
}

export const PROVIDERS: Record<Provider, ProviderSpec> = {
  anthropic: { egress: ["api.anthropic.com"], credentialEnv: "ANTHROPIC_API_KEY" },
  openrouter: { egress: ["openrouter.ai"], credentialEnv: "OPENROUTER_API_KEY" },
};

/** Base URL of OpenRouter's Anthropic-compatible Messages API. */
export const OPENROUTER_ANTHROPIC_BASE_URL = "https://openrouter.ai/api";

/**
 * Environment that points Claude Code at a provider. Claude Code speaks the Anthropic
 * Messages API, which OpenRouter also serves, so any OpenRouter model with tool use
 * works through it. Every model role (including the small fast model used for
 * background work) is pinned to the agent's model, so a run never falls back to an
 * Anthropic model billed through OpenRouter.
 */
export function claudeCodeEnv(choice: ModelChoice, credential: string): Record<string, string> {
  switch (choice.provider) {
    case "anthropic":
      return { ANTHROPIC_API_KEY: credential };
    case "openrouter":
      return {
        ANTHROPIC_BASE_URL: OPENROUTER_ANTHROPIC_BASE_URL,
        ANTHROPIC_AUTH_TOKEN: credential,
        // Must be empty: a set key is sent as x-api-key and can route the request to Anthropic.
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_DEFAULT_FABLE_MODEL: choice.model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: choice.model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: choice.model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: choice.model,
        CLAUDE_CODE_SUBAGENT_MODEL: choice.model,
      };
  }
}

/**
 * Builds the harness access for an agent's model choice from host environment
 * variables. Throws when the provider's credential is missing, or when the harness
 * can't use the provider.
 */
export function harnessAccessFromEnv(env: NodeJS.ProcessEnv) {
  return (choice: ModelChoice): HarnessAccess => {
    const spec = PROVIDERS[choice.provider];
    const credential = env[spec.credentialEnv];
    if (!credential) throw new Error(`${spec.credentialEnv} is not set (needed for provider ${choice.provider})`);
    if (choice.harness !== "claude-code") throw new Error(`harness ${choice.harness} has no provider wiring`);
    return { env: claudeCodeEnv(choice, credential), egress: [...spec.egress] };
  };
}
