import { describe, expect, it } from "vitest";
import { editTags, normalTag, type TagEdit } from "../src/chat/tag-edit";

const ok = (r: TagEdit | { error: string }): TagEdit => {
  if ("error" in r) throw new Error(r.error);
  return r;
};

describe("normalTag", () => {
  it("takes a tag with or without #, and refuses what Obsidian would not read as one", () => {
    expect(normalTag("#project/ariadne")).toBe("project/ariadne");
    expect(normalTag(" reading-list ")).toBe("reading-list");
    expect(normalTag("über_alles")).toBe("über_alles");
    for (const bad of ["", "#", "2026", "a b", "x#y", "/lead", "trail/", "a//b", "-dash", "q?"]) expect(normalTag(bad)).toBeNull();
  });
});

describe("editTags", () => {
  it("changes only the tags property in a dash list, keeping its indent and every other line", () => {
    const note = "---\ntitle: Plan\ntags:\n    - work\n    - draft\nstatus: open\n---\n# Plan\n\nBody #draft stays.\n";
    const r = ok(editTags(note, ["project/ariadne"], ["draft"]));
    expect(r.text).toBe("---\ntitle: Plan\ntags:\n    - work\n    - project/ariadne\nstatus: open\n---\n# Plan\n\nBody #draft stays.\n");
    expect(r.added).toEqual(["project/ariadne"]);
    expect(r.removed).toEqual(["draft"]);
  });

  it("keeps an inline list inline, matching tags without regard to case", () => {
    const r = ok(editTags("---\ntags: [Work, \"draft\"]\n---\ntext\n", ["home"], ["DRAFT"]));
    expect(r.text).toBe("---\ntags: [Work, home]\n---\ntext\n");
    expect(ok(editTags("---\ntags: [Work]\n---\n", ["work"], [])).added).toEqual([]);
  });

  it("reads a tag written as plain words, and writes the result as a list", () => {
    expect(ok(editTags("---\ntags: work, home\n---\n", ["later"], [])).text).toBe("---\ntags:\n  - work\n  - home\n  - later\n---\n");
    expect(ok(editTags("---\ntag: work\n---\n", ["home"], [])).text).toBe("---\ntag:\n  - work\n  - home\n---\n");
  });

  it("gives a note without properties a tags property, and adds one to properties without it", () => {
    expect(ok(editTags("# Idea\n", ["inbox"], [])).text).toBe("---\ntags:\n  - inbox\n---\n# Idea\n");
    expect(ok(editTags("---\ntitle: Idea\n---\n# Idea\n", ["inbox"], [])).text).toBe("---\ntitle: Idea\ntags:\n  - inbox\n---\n# Idea\n");
  });

  it("takes the property out when its last tag goes, and the properties too when nothing else is in them", () => {
    expect(ok(editTags("---\ntitle: A\ntags: [x]\n---\nbody\n", [], ["x"])).text).toBe("---\ntitle: A\n---\nbody\n");
    expect(ok(editTags("---\ntags:\n  - x\n---\nbody\n", [], ["x"])).text).toBe("body\n");
  });

  it("leaves a tag written in the text alone and says so; a tag the note lacks is just missing", () => {
    const r = ok(editTags("---\ntags: [a]\n---\nSee #later here.\n", [], ["later", "nope"]));
    expect(r.text).toBe("---\ntags: [a]\n---\nSee #later here.\n");
    expect(r.inline).toEqual(["later"]);
    expect(r.missing).toEqual(["nope"]);
  });

  it("quotes a tag YAML would read as something else", () => {
    expect(ok(editTags("---\ntags: [a]\n---\n", ["true", "2026-review"], [])).text).toBe('---\ntags: [a, "true", "2026-review"]\n---\n');
  });

  it("keeps Windows line endings", () => {
    expect(ok(editTags("---\r\ntitle: A\r\n---\r\nbody\r\n", ["x"], [])).text).toBe("---\r\ntitle: A\r\ntags:\r\n  - x\r\n---\r\nbody\r\n");
  });

  it("refuses what it would have to guess at", () => {
    expect(editTags("---\ntags: [a,\n  b]\n---\n", ["c"], [])).toHaveProperty("error");
    expect(editTags("---\ntags: a\ntags: b\n---\n", ["c"], [])).toHaveProperty("error");
    expect(editTags("---\ntags: >\n  a\n---\n", ["c"], [])).toHaveProperty("error");
    expect(editTags("x", ["ok"], ["ok"])).toHaveProperty("error");
    expect(editTags("x", ["not a tag"], [])).toHaveProperty("error");
  });
});
