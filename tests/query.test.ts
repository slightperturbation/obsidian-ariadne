import { describe, it, expect } from "vitest";
import { parseQuery } from "../src/search/query";

describe("parseQuery", () => {
  it("returns plain text when no operators are present", () => {
    const q = parseQuery("open endedness in evolution");
    expect(q.text).toBe("open endedness in evolution");
    expect(q.filters).toEqual({});
    expect(q.phrases).toEqual([]);
  });

  it("extracts type, in, and since operators", () => {
    const q = parseQuery("agents type:permanent in:Research since:2024-01");
    expect(q.filters).toEqual({ type: "permanent", folder: "Research", since: "2024-01" });
    expect(q.text).toBe("agents");
  });

  it("supports quoted operator values and quoted phrases", () => {
    const q = parseQuery('in:"Machine Learning" "central limit" theorem');
    expect(q.filters.folder).toBe("Machine Learning");
    expect(q.phrases).toEqual(["central limit"]);
    expect(q.text).toBe("theorem");
  });

  it("is case-insensitive on operator keys", () => {
    const q = parseQuery("TYPE:concept note");
    expect(q.filters.type).toBe("concept");
    expect(q.text).toBe("note");
  });
});
