import type { PutObjectCommand } from "@aws-sdk/client-s3";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FileTranscriptStore, S3TranscriptStore, transcriptStoreFromEnv } from "../src/harness/transcripts.js";

/** Records PutObject calls instead of talking to AWS. */
class FakeS3 {
  readonly puts: PutObjectCommand["input"][] = [];
  async send(command: PutObjectCommand) {
    this.puts.push(command.input);
    return {};
  }
}

const lines = ['{"type":"assistant","text":"key AKIAIOSFODNN7EXAMPLE"}', '{"type":"result"}'];

describe("S3TranscriptStore", () => {
  it("writes a redacted, encrypted object under <prefix>/<task>/<run>.jsonl", async () => {
    const s3 = new FakeS3();
    const uri = await new S3TranscriptStore({ bucket: "cell-transcripts", client: s3 }).write("task-1", "run-1", lines);

    expect(uri).toBe("s3://cell-transcripts/transcripts/task-1/run-1.jsonl");
    const put = s3.puts[0]!;
    expect(put).toMatchObject({
      Bucket: "cell-transcripts",
      Key: "transcripts/task-1/run-1.jsonl",
      ContentType: "application/x-ndjson",
      ServerSideEncryption: "AES256",
    });
    expect(put.Body).toContain("[REDACTED AWS access key id]");
    expect(put.Body).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("honors a custom prefix and trims stray slashes", async () => {
    const s3 = new FakeS3();
    const uri = await new S3TranscriptStore({ bucket: "b-1", prefix: "/cells/acme/", client: s3 }).write("t", "r", lines);
    expect(uri).toBe("s3://b-1/cells/acme/t/r.jsonl");
  });

  it("surfaces S3 errors to the caller (the adapter records them on the run)", async () => {
    const failing = { send: async () => Promise.reject(new Error("AccessDenied")) };
    await expect(new S3TranscriptStore({ bucket: "b-1", client: failing }).write("t", "r", lines)).rejects.toThrow(/AccessDenied/);
  });
});

describe("transcriptStoreFromEnv", () => {
  it("defaults to files", async () => {
    const store = transcriptStoreFromEnv({ SHIRA_TRANSCRIPTS_DIR: `${process.env.TMPDIR ?? "/tmp"}/shira-transcripts-test` });
    expect(store).toBeInstanceOf(FileTranscriptStore);
    const uri = await store.write("t", "r", lines);
    expect(await readFile(fileURLToPath(uri), "utf8")).toContain("[REDACTED AWS access key id]");
  });

  it("uses S3 for s3:// URIs, with an optional prefix", async () => {
    const s3 = new FakeS3();
    expect(await transcriptStoreFromEnv({ SHIRA_TRANSCRIPTS_URI: "s3://cell-transcripts" }, s3).write("t", "r", lines)).toBe(
      "s3://cell-transcripts/transcripts/t/r.jsonl",
    );
    expect(await transcriptStoreFromEnv({ SHIRA_TRANSCRIPTS_URI: "s3://cell-transcripts/runs" }, s3).write("t", "r", lines)).toBe(
      "s3://cell-transcripts/runs/t/r.jsonl",
    );
  });

  it("rejects anything that isn't an s3:// bucket URI", () => {
    expect(() => transcriptStoreFromEnv({ SHIRA_TRANSCRIPTS_URI: "https://example.com/bucket" })).toThrow(/s3:\/\/bucket/);
    expect(() => transcriptStoreFromEnv({ SHIRA_TRANSCRIPTS_URI: "s3://Bad_Bucket" })).toThrow(/s3:\/\/bucket/);
  });
});
