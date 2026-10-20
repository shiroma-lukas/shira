import { describe, expect, it } from "vitest";
import { redact, scanDiff } from "../src/security/secrets.js";

describe("scanDiff", () => {
  it("flags secrets on added lines only", () => {
    const diff = ["+++ b/config.ts", "-old = 'AKIAIOSFODNN7EXAMPLE'", "+token = 'ghp_" + "a".repeat(36) + "'", " context"].join("\n");
    expect(scanDiff(diff)).toEqual([{ pattern: "GitHub token", line: 3 }]);
  });

  it("ignores ordinary code", () => {
    expect(scanDiff("+const url = 'https://example.com/path';\n+const key = process.env.API_KEY;")).toEqual([]);
  });
});

describe("redact", () => {
  it("replaces credentials with a marker", () => {
    expect(redact("db: postgres://app:hunter22@db.internal/prod")).toBe("db: [REDACTED URL with password]/prod");
    expect(redact("-----BEGIN RSA PRIVATE KEY-----")).toBe("[REDACTED private key]");
  });
});
