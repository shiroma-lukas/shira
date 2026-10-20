import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
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

/** The one S3 call the store makes; S3Client satisfies it, tests pass a fake. */
export interface S3Putter {
  send(command: PutObjectCommand): Promise<unknown>;
}

/**
 * Transcripts in S3 (Shira Cloud, or any self-hosted AWS install). Objects land at
 * `<prefix>/<task>/<run>.jsonl`, redacted first, encrypted at rest. Retention is the
 * bucket's lifecycle rule.
 */
export class S3TranscriptStore implements TranscriptStore {
  private readonly client: S3Putter;

  constructor(private readonly opts: { bucket: string; prefix?: string; client?: S3Putter }) {
    // Region and credentials come from the environment (instance role on Shira Cloud hosts).
    this.client = opts.client ?? new S3Client({});
  }

  async write(taskId: string, runId: string, lines: readonly string[]): Promise<string> {
    const prefix = (this.opts.prefix ?? "transcripts").replace(/^\/+|\/+$/g, "");
    const key = `${prefix ? `${prefix}/` : ""}${taskId}/${runId}.jsonl`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        Body: lines.map(redact).join("\n") + "\n",
        ContentType: "application/x-ndjson",
        ServerSideEncryption: "AES256",
      }),
    );
    return `s3://${this.opts.bucket}/${key}`;
  }
}

/**
 * Picks the store from settings: `SHIRA_TRANSCRIPTS_URI=s3://bucket[/prefix]` for S3,
 * otherwise files under `SHIRA_TRANSCRIPTS_DIR` (default .shira/transcripts).
 */
export function transcriptStoreFromEnv(env: NodeJS.ProcessEnv, client?: S3Putter): TranscriptStore {
  const uri = env.SHIRA_TRANSCRIPTS_URI;
  if (!uri) return new FileTranscriptStore(env.SHIRA_TRANSCRIPTS_DIR ?? ".shira/transcripts");
  const m = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])(?:\/(.*))?$/.exec(uri);
  if (!m) throw new Error(`SHIRA_TRANSCRIPTS_URI must look like s3://bucket[/prefix], got ${uri}`);
  return new S3TranscriptStore({ bucket: m[1]!, prefix: m[2] ?? "transcripts", ...(client ? { client } : {}) });
}
