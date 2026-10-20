// shira: command-line intake and admin for the platform (FR-Q1, FR-Q4, FR-S4).
import { userInfo } from "node:os";
import { parseArgs } from "node:util";
import pg from "pg";
import { loadConfig } from "../config/load.js";
import { TaskStatus } from "../contracts/index.js";
import { fromPool, type Db } from "../db/client.js";
import { migrate } from "../db/migrate.js";
import { Ledger } from "../ledger/ledger.js";
import { submit } from "../queue/intake.js";
import { Settings } from "../queue/settings.js";
import { githubFromEnv, runDispatcher, type SandboxMode } from "./dispatch.js";
import { TaskStore, type Task } from "../queue/store.js";

const USAGE = `usage: shira <command> [options]

  migrate                                   apply database migrations
  submit --repo <org/name> --goal <text>    queue a task
         [--issue <n>]                      ...or resolve a GitHub issue (goal optional)
         [--path <glob>]... [--priority <n>]
  list [--status <status>] [--limit <n>]    list recent tasks
  show <task-id>                            task details, spend, and event log
  cancel <task-id> [--reason <text>]        cancel an unfinished task
  answer <task-id> --text <text>            answer a task's open question; it resumes
         [--choice <n>]
  resume <task-id>                          requeue a paused or blocked task
  kill on|off|status                        pause or resume all agents
  budget monthly <usd>|none                 set the monthly org spend ceiling
  dispatch                                  run tasks in gVisor sandboxes (needs the egress proxy:
                                            docker compose --profile sandbox up)
           [--concurrency <n>]              tasks to run at once (default 1)
           [--unsafe-runtime]               allow SHIRA_SANDBOX_RUNTIME other than runsc (e.g. runc on macOS)
           [--unsafe-local-sandbox]         run agents directly on this machine, no isolation

env: DATABASE_URL (default postgres://shira:shira@localhost:54329/shira), SHIRA_CONFIG (default ./config)
     dispatch needs SHIRA_GITHUB_APP_ID, SHIRA_GITHUB_PRIVATE_KEY_PATH, ANTHROPIC_API_KEY, and for
     Docker SHIRA_EGRESS_ADMIN_TOKEN; see docs/self-hosting.md for the optional ones`;

const actor = `cli:${userInfo().username}`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function line(t: Task): string {
  return [t.id, t.status.padEnd(14), t.role.padEnd(8), t.repo, JSON.stringify(t.goal)].join("  ");
}

async function main(db: Db, argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const store = new TaskStore(db);

  switch (command) {
    case "migrate": {
      const applied = await migrate(db);
      console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
      return;
    }
    case "submit": {
      const { values } = parseArgs({
        args: rest,
        options: {
          repo: { type: "string" },
          goal: { type: "string" },
          issue: { type: "string" },
          path: { type: "string", multiple: true },
          priority: { type: "string" },
        },
      });
      if (!values.repo || (!values.goal && !values.issue)) fail("submit needs --repo and --goal or --issue");
      const config = await loadConfig(process.env.SHIRA_CONFIG ?? "config");
      if (!config.ok) fail(config.errors.map((e) => `${e.file}: ${e.message}`).join("\n"));
      const task = await submit(db, config.config, {
        source: "cli",
        requester: actor,
        repo: values.repo,
        goal: values.goal,
        ...(values.issue ? { issue: Number(values.issue) } : {}),
        paths: values.path,
        priority: values.priority ? Number(values.priority) : 0,
      }, values.issue ? { issues: await githubFromEnv() } : {});
      console.log(line(task));
      return;
    }
    case "list": {
      const { values } = parseArgs({ args: rest, options: { status: { type: "string" }, limit: { type: "string" } } });
      const status = values.status === undefined ? undefined : TaskStatus.parse(values.status);
      const tasks = await store.list({ status, limit: values.limit ? Number(values.limit) : 50 });
      for (const t of tasks) console.log(line(t));
      return;
    }
    case "show": {
      const id = rest[0] ?? fail("show needs a task id");
      const task = (await store.get(id)) ?? fail(`task ${id} not found`);
      const spend = await new Ledger(db).taskSpend(id);
      console.log(line(task));
      console.log(`  priority ${task.priority}, attempts ${task.attempts}, retries ${task.retriesUsed}/${task.budget.retries}`);
      console.log(
        `  spend $${spend.usd.toFixed(2)}/$${task.budget.usd}, ${spend.tokens}/${task.budget.tokens} tokens, ` +
          `${spend.minutes.toFixed(1)}/${task.budget.minutes} min`,
      );
      console.log(`  scope ${task.scope.paths.join(", ")}`);
      const events = await store.events(id);
      if (task.status === "needs_decision") {
        const q = events.findLast((e) => e.toStatus === "needs_decision")?.payload.question as
          | { kind: string; text: string; options?: string[] }
          | undefined;
        if (q) {
          console.log(`  question (${q.kind}): ${q.text}`);
          q.options?.forEach((o, i) => console.log(`    [${i}] ${o}`));
        }
      }
      for (const e of events) {
        const change = e.kind === "state_change" ? `${e.fromStatus ?? "-"} -> ${e.toStatus}` : e.kind;
        const payload = Object.keys(e.payload).length ? ` ${JSON.stringify(e.payload)}` : "";
        console.log(`  ${e.at.toISOString()}  ${e.actor.padEnd(14)} ${change}${payload}`);
      }
      return;
    }
    case "cancel": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { reason: { type: "string" } } });
      const id = positionals[0] ?? fail("cancel needs a task id");
      console.log(line(await store.cancel(id, actor, values.reason)));
      return;
    }
    case "answer": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { text: { type: "string" }, choice: { type: "string" } },
      });
      const id = positionals[0] ?? fail("answer needs a task id");
      if (!values.text) fail("answer needs --text");
      const asked = (await store.events(id)).findLast((e) => e.toStatus === "needs_decision");
      if (!asked) fail(`task ${id} has no open question`);
      const task = await store.answer({
        v: 1,
        task_id: id,
        in_reply_to: asked.payload.reply_id as string,
        answered_by: actor,
        text: values.text,
        ...(values.choice !== undefined ? { choice: Number(values.choice) } : {}),
      });
      console.log(line(task));
      return;
    }
    case "resume": {
      const id = rest[0] ?? fail("resume needs a task id");
      console.log(line(await store.transition(id, "queued", { actor, from: ["paused", "blocked"] })));
      return;
    }
    case "kill": {
      const settings = new Settings(db);
      const mode = rest[0];
      if (mode === "on" || mode === "off") await settings.setAgentsPaused(mode === "on", actor);
      else if (mode !== "status") fail("kill needs on, off, or status");
      console.log((await settings.agentsPaused()) ? "agents paused: no new tasks will be claimed" : "agents running");
      return;
    }
    case "budget": {
      const [scope, value] = rest;
      if (scope !== "monthly" || value === undefined) fail("budget needs: monthly <usd>|none");
      await new Settings(db).setMonthlyBudgetUsd(value === "none" ? null : Number(value), actor);
      console.log(`monthly budget: ${value === "none" ? "not set" : `$${value}`}`);
      return;
    }
    case "dispatch": {
      const { values: flags } = parseArgs({
        args: rest,
        options: {
          concurrency: { type: "string", default: "1" },
          "unsafe-runtime": { type: "boolean", default: false },
          "unsafe-local-sandbox": { type: "boolean", default: false },
        },
      });
      const concurrency = Number(flags.concurrency);
      if (!Number.isInteger(concurrency) || concurrency < 1) fail("--concurrency must be a positive integer");
      const mode: SandboxMode = flags["unsafe-local-sandbox"]
        ? { kind: "local-unsafe" }
        : { kind: "docker", unsafeRuntime: flags["unsafe-runtime"] };
      const config = await loadConfig(process.env.SHIRA_CONFIG ?? "config");
      if (!config.ok) fail(config.errors.map((e) => `${e.file}: ${e.message}`).join("\n"));
      // SIGINT (Ctrl-C) and SIGTERM (systemd, containers) both finish the current task first.
      const stop = new AbortController();
      for (const sig of ["SIGINT", "SIGTERM"] as const) {
        process.once(sig, () => {
          console.log(`${sig}: stopping after the current task (send again to quit now)`);
          stop.abort();
          process.once(sig, () => process.exit(130));
        });
      }
      await runDispatcher(db, config.config, mode, stop.signal, concurrency);
      return;
    }
    default:
      fail(USAGE);
  }
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://shira:shira@localhost:54329/shira" });
try {
  await main(fromPool(pool), process.argv.slice(2));
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
