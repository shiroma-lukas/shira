// CI entry point: validates agent and repo definitions (FR-A3). Exits non-zero on any problem.
import { loadConfig } from "./load.js";

const root = process.argv[2] ?? "config";
const result = await loadConfig(root);

if (result.ok) {
  const { agents, repos } = result.config;
  console.log(`config ok: ${agents.length} agent(s), ${repos.length} repo(s)`);
} else {
  for (const e of result.errors) console.error(`${e.file}: ${e.message}`);
  console.error(`config invalid: ${result.errors.length} problem(s)`);
  process.exit(1);
}
