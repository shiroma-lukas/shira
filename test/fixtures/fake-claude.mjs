#!/usr/bin/env node
// Stands in for `claude -p ... --output-format stream-json` in tests. Behavior is chosen
// by FAKE_CLAUDE_SCENARIO; argv is appended to FAKE_CLAUDE_ARGS_FILE for assertions.
import { execSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? "done";
if (process.env.FAKE_CLAUDE_ARGS_FILE) appendFileSync(process.env.FAKE_CLAUDE_ARGS_FILE, JSON.stringify(process.argv.slice(2)) + "\n");
// The provider wiring the sandbox handed the harness, for assertions.
if (process.env.FAKE_CLAUDE_ENV_FILE) {
  const keys = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_DEFAULT_HAIKU_MODEL"];
  appendFileSync(process.env.FAKE_CLAUDE_ENV_FILE, JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]))) + "\n");
}
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const session_id = arg("--session-id");
const emit = (e) => process.stdout.write(JSON.stringify({ session_id, ...e }) + "\n");
const usage = { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 };
const result = (extra) => emit({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.42, duration_ms: 1234, usage, ...extra });

emit({ type: "system", subtype: "init", model: arg("--model"), tools: ["Bash", "Read"] });
emit({ type: "assistant", message: { content: [{ type: "text", text: "Working. Found key AKIAIOSFODNN7EXAMPLE in env." }] } });

switch (scenario) {
  case "done":
    execSync("echo fixed > app.txt && git commit --quiet -am 'fix app'");
    result({ structured_output: { status: "done", summary: "Fixed app.txt.", title: "Make the app say fixed" } });
    break;
  case "ask":
    execSync("echo half > notes.txt");
    result({ structured_output: { status: "needs_decision", summary: "Need a choice.", question: { kind: "technical", text: "A or B?", options: ["A", "B"] } } });
    break;
  case "unknown_model":
    // What Claude Code reports for a model it has no price for: a guessed Claude price,
    // zeroed top-level usage, and the real token counts per model.
    execSync("echo fixed > app.txt && git commit --quiet -am 'fix app'");
    result({
      total_cost_usd: 24,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      modelUsage: {
        [arg("--model")]: { inputTokens: 1_000_000, outputTokens: 200_000, cacheReadInputTokens: 500_000, cacheCreationInputTokens: 0, costUSD: 24, costBasis: "unknown" },
      },
      structured_output: { status: "done", summary: "Fixed app.txt." },
    });
    break;
  case "overspend": {
    // Streams usage like Claude Code does: one event per content block, the same usage on
    // each, and output_tokens as of the message's start. Then keeps going until killed.
    const assistant = (id, input_tokens, content) =>
      emit({ type: "assistant", message: { id, content, usage: { input_tokens, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
    assistant("msg_1", 1_000_000, [{ type: "text", text: "x".repeat(300) }]);
    assistant("msg_1", 1_000_000, [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]);
    assistant("msg_2", 2_000_000, [{ type: "text", text: "y".repeat(300) }]);
    setInterval(() => {}, 1000);
    break;
  }
  case "no_credits":
    result({ is_error: true, api_error_status: 402, result: "API Error: 402 Insufficient credits", total_cost_usd: 0 });
    break;
  case "auth_error":
    result({ is_error: true, result: "Not logged in · Please run /login", total_cost_usd: 0 });
    break;
  case "workspace_error":
    result({ is_error: true, api_error_status: 400, result: "API Error: 400 This API key is not scoped to a workspace", total_cost_usd: 0 });
    break;
  case "rate_limited":
    result({ is_error: true, api_error_status: 429, result: "API Error: 429 rate limited", total_cost_usd: 0 });
    break;
  case "budget":
    result({ subtype: "error_max_budget_usd", is_error: true });
    break;
  case "crash":
    process.stderr.write("segfault-ish\n");
    process.exit(3);
  case "hang":
    setInterval(() => {}, 1000);
    break;
}
