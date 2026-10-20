import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { redact } from "../security/secrets.js";

/**
 * Where run transcripts go (FR-L2). Implementations redact before storing (FR-L3);
 * retention is the storage backend's job (e.g. an object store lifecycle rule).
 */
export interface TranscriptStore {
  /** Stores one run's transcript and returns its URI. */
  write(taskId: string, runId: string, lines: readonly string[]): Promise<string>;
}

/** Local directory store, for development and single-host installs. */
export class FileTranscriptStore implements TranscriptStore {
  constructor(private readonly dir: string) {}

  async write(taskId: string, runId: string, lines: readonly string[]): Promise<string> {
    const taskDir = join(resolve(this.dir), taskId);
    await mkdir(taskDir, { recursive: true });
    const file = join(taskDir, `${runId}.jsonl`);
    await writeFile(file, lines.map(redact).join("\n") + "\n", { mode: 0o600 });
    return pathToFileURL(file).href;
  }
}
