import { describe, expect, it } from "vitest";
import { AgentDefinition, ModelChoice } from "../src/contracts/index.js";
import { claudeCodeEnv, harnessAccessFromEnv } from "../src/harness/providers.js";
import { costUsd, OpenRouterPriceTable, parseOpenRouterPrices } from "../src/ledger/prices.js";

const glm = ModelChoice.parse({ harness: "claude-code", model: "z-ai/glm-5.3-flash", provider: "openrouter" });

describe("model providers", () => {
  it("defaults to Anthropic, so existing agent definitions keep working", () => {
    expect(ModelChoice.parse({ harness: "claude-code", model: "claude-sonnet-5-5" }).provider).toBe("anthropic");
    expect(() => ModelChoice.parse({ harness: "claude-code", model: "x", provider: "nope" })).toThrow();
  });

  it("points Claude Code at OpenRouter with every model role pinned to the agent's model", () => {
    const env = claudeCodeEnv(glm, "sk-or-1");
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      ANTHROPIC_AUTH_TOKEN: "sk-or-1",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "z-ai/glm-5.3-flash",
      CLAUDE_CODE_SUBAGENT_MODEL: "z-ai/glm-5.3-flash",
    });
    expect(claudeCodeEnv({ ...glm, provider: "anthropic" }, "sk-ant-1")).toEqual({ ANTHROPIC_API_KEY: "sk-ant-1" });
  });

  it("opens egress only to the agent's provider", () => {
    const access = harnessAccessFromEnv({ OPENROUTER_API_KEY: "sk-or-1", ANTHROPIC_API_KEY: "sk-ant-1" });
    expect(access(glm).egress).toEqual(["openrouter.ai"]);
    expect(access({ ...glm, provider: "anthropic" }).egress).toEqual(["api.anthropic.com"]);
  });

  it("names the missing credential", () => {
    expect(() => harnessAccessFromEnv({})(glm)).toThrow(/OPENROUTER_API_KEY is not set/);
    expect(() => harnessAccessFromEnv({ OPENROUTER_API_KEY: "k" })({ ...glm, harness: "codex" })).toThrow(/no provider wiring/);
  });

  it("accepts an OpenRouter agent definition", () => {
    const def = AgentDefinition.parse({
      apiVersion: "shira/v1",
      kind: "Agent",
      role: "worker",
      description: "d",
      model: { primary: { harness: "claude-code", model: "z-ai/glm-5.3-flash", provider: "openrouter" } },
      permissions: ["read"],
      budget: { usd: 1, tokens: 1000, minutes: 1, retries: 0 },
      instructions: "roles/worker.md",
    });
    expect(def.model.primary.provider).toBe("openrouter");
  });
});

describe("OpenRouter prices", () => {
  const body = {
    data: [
      { id: "z-ai/glm-5.3-flash", pricing: { prompt: "0.000000047076", completion: "0.00000012", input_cache_read: "0.000000006" } },
      { id: "free/model", pricing: { prompt: "0", completion: "0" } },
      { id: "variable/router", pricing: { prompt: "-1", completion: "-1" } },
      { id: "no/pricing" },
    ],
  };

  it("parses per-token prices and skips models without a usable price", () => {
    const prices = parseOpenRouterPrices(body);
    expect(prices.get("z-ai/glm-5.3-flash")).toEqual({ input: 0.000000047076, output: 0.00000012, cacheRead: 0.000000006 });
    expect(prices.get("free/model")).toEqual({ input: 0, output: 0 });
    expect(prices.has("variable/router")).toBe(false);
    expect(prices.has("no/pricing")).toBe(false);
  });

  it("charges cache tokens at the input price when no cache price is listed", () => {
    const t = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 20 };
    expect(costUsd({ input: 1, output: 2 }, t)).toBe(100 + 20 + 50 + 20);
    expect(costUsd({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 }, t)).toBeCloseTo(100 + 20 + 5 + 25);
  });

  it("fetches once, strips Claude Code's [1m] suffix, and keeps prices when a refresh fails", async () => {
    let calls = 0;
    let fail = false;
    const fetch = (async () => {
      calls++;
      return fail ? new Response("down", { status: 503 }) : Response.json(body);
    }) as typeof globalThis.fetch;
    const table = new OpenRouterPriceTable({ fetch, ttlMs: 60_000 });
    expect(table.lookup("z-ai/glm-5.3-flash")).toBeNull(); // nothing fetched yet
    await table.refresh();
    await table.refresh();
    expect(calls).toBe(1);
    expect(table.lookup("z-ai/glm-5.3-flash[1m]")?.output).toBe(0.00000012);

    const stale = new OpenRouterPriceTable({ fetch, ttlMs: 0 });
    await stale.refresh();
    fail = true;
    await expect(stale.refresh()).rejects.toThrow(/HTTP 503/);
    expect(stale.lookup("z-ai/glm-5.3-flash")).not.toBeNull();
  });
});
