// CI entry point: validates agent and repo definitions (FR-A3) and, given a context repo
// checkout, its people files (FR-H2). Exits non-zero on any problem.
import { loadPeople } from "../people/people.js";
import { loadConfig } from "./load.js";

const root = process.argv[2] ?? "config";
const contextDir = process.argv[3];
const result = await loadConfig(root);
const people = contextDir ? await loadPeople(contextDir) : null;
const errors = [...(result.ok ? [] : result.errors), ...(people && !people.ok ? people.errors : [])];

if (errors.length) {
  for (const e of errors) console.error(`${e.file}: ${e.message}`);
  console.error(`config invalid: ${errors.length} problem(s)`);
  process.exit(1);
}
if (result.ok) console.log(`config ok: ${result.config.agents.length} agent(s), ${result.config.repos.length} repo(s)`);
if (people?.ok) {
  const p = people.people;
  console.log(`context ok: ${p.identities.length} identities, ${p.rules.length} approval rule(s), ${p.owners.length} owner(s)`);
}
