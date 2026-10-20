import type { Task } from "../queue/store.js";

interface EventLike {
  toStatus: string | null;
  payload: Record<string, unknown>;
}

/** Lines naming the task's linked GitHub issue and its PR, when they exist. */
export function linkLines(task: Pick<Task, "threadRef" | "repo">, events: EventLike[]): string[] {
  const out: string[] = [];
  const ref = task.threadRef;
  if (ref && ref.kind === "thread" && ref.provider === "github") {
    const m = /^(.+)#(\d+)$/.exec(ref.id);
    out.push(m ? `  issue ${ref.id}  https://github.com/${m[1]}/issues/${m[2]}` : `  issue ${ref.id}`);
  }
  const pr = events.findLast((e) => e.toStatus === "done" && e.payload.pr)?.payload.pr as
    | { repo?: string; number: number; url: string }
    | undefined;
  if (pr) out.push(`  pr ${pr.repo ?? task.repo}#${pr.number}  ${pr.url}`);
  return out;
}
