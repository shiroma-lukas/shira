import { describe, expect, it } from "vitest";
import { linkLines } from "../src/cli/show.js";

const ref = { kind: "thread", provider: "github", id: "o/r#1" } as const;

describe("linkLines", () => {
  it("prints issue and PR", () => {
    const out = linkLines({ repo: "o/r", threadRef: ref }, [
      { toStatus: "done", payload: { pr: { repo: "o/r", number: 7, url: "https://github.com/o/r/pull/7" } } },
    ]);
    expect(out).toEqual(["  issue o/r#1  https://github.com/o/r/issues/1", "  pr o/r#7  https://github.com/o/r/pull/7"]);
  });
  it("prints nothing without links", () => {
    expect(linkLines({ repo: "o/r", threadRef: null }, [{ toStatus: "running", payload: {} }])).toEqual([]);
  });
});
