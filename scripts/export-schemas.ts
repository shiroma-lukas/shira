// Writes JSON Schemas for the YAML configs, so editors can validate them inline.
import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { AgentDefinition, Envelope, RepoConfig, Reply } from "../src/contracts/index.js";
import { ApprovalsFile, IdentitiesFile, OwnershipFile } from "../src/contracts/people.js";

const schemas = {
  agent: AgentDefinition,
  repo: RepoConfig,
  envelope: Envelope,
  reply: Reply,
  identities: IdentitiesFile,
  approvals: ApprovalsFile,
  ownership: OwnershipFile,
};

await mkdir("schemas", { recursive: true });
for (const [name, schema] of Object.entries(schemas)) {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  await writeFile(`schemas/${name}.json`, JSON.stringify(json, null, 2) + "\n");
  console.log(`schemas/${name}.json`);
}
