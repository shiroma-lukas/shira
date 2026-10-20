#!/usr/bin/env node
// Stands in for `claude -p ... --output-format stream-json` in tests. Behavior is chosen
// by FAKE_CLAUDE_SCENARIO; argv is appended to FAKE_CLAUDE_ARGS_FILE for assertions.
import { execSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? "done";
if (process.env.FAKE_CLAUDE_ARGS_FILE) appendFileSync(process.env.FAKE_CLAUDE_ARGS_FILE, JSON.stringify(process.argv.slice(2)) + "\n");
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
    result({ structured_output: { status: "done", summary: "Fixed app.txt." } });
    break;
  case "ask":
    execSync("echo half > notes.txt");
    result({ structured_output: { status: "needs_decision", summary: "Need a choice.", question: { kind: "technical", text: "A or B?", options: ["A", "B"] } } });
    break;
  case "auth_error":
    result({ is_error: true, result: "Not logged in · Please run /login", total_cost_usd: 0 });
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
