import { describe, expect, it } from "vitest";
import {
  changedSince,
  contentHash,
  personalSignals,
  polishProblems,
  type PublishLedger,
} from "../src/publish/screen";
import { parsePublishScreen, publishScreenPrompt } from "../src/model/tasks";

describe("personalSignals — high recall red flags", () => {
  it("flags relationship, emotional, intimate, health, and finance content", () => {
    expect(personalSignals("Talked with my wife about the move.")).toContain(
      "mentions people close to you",
    );
    expect(personalSignals("I feel like everything is falling apart lately.")).toContain(
      "first-person emotional content",
    );
    expect(personalSignals("Our sex life has been on my mind.")).toContain("intimate content");
    expect(personalSignals("My therapist suggested journaling about it.")).toEqual(
      expect.arrayContaining(["mentions people close to you", "health content"]),
    );
    expect(personalSignals("My salary negotiation went poorly.")).toContain("personal finances");
    expect(personalSignals("export API_KEY=abc123 into the env")).toContain(
      "credential-like content",
    );
  });

  it("stays quiet on impersonal idea notes", () => {
    expect(
      personalSignals(
        "Spaced repetition trades transfer for retention. The literature on testing effects " +
          "suggests retrieval practice strengthens isolated recall more than schema formation.",
      ),
    ).toEqual([]);
  });

  it("frontmatter is not scanned — publish: false there is not 'credential-like'", () => {
    expect(personalSignals("---\napi_note: none\n---\nClean body text here.")).toEqual([]);
  });
});

describe("parsePublishScreen — fails toward hold", () => {
  it("parses valid verdicts", () => {
    expect(parsePublishScreen('{"verdict":"clear"}')).toEqual({ verdict: "clear" });
    expect(parsePublishScreen('{"verdict":"hold","reason":"names your manager."}')).toEqual({
      verdict: "hold",
      reason: "names your manager",
    });
  });

  it("ANY malformed answer is a hold — failing open on a privacy gate is a breach", () => {
    expect(parsePublishScreen("garbage").verdict).toBe("hold");
    expect(parsePublishScreen('{"verdict":"maybe"}').verdict).toBe("hold");
    expect(parsePublishScreen('{"decision":"clear"}').verdict).toBe("hold");
    expect(parsePublishScreen("").verdict).toBe("hold");
  });

  it("the prompt states the asymmetry and carries the local flags", () => {
    const p = publishScreenPrompt({ title: "T", content: "c", localFlags: ["intimate content"] });
    expect(p).toContain("When uncertain, HOLD");
    expect(p).toContain("intimate content");
  });
});

describe("polishProblems", () => {
  it("catches the bedroom-link leak, unresolved links, TODOs, and stubs", () => {
    const problems = polishProblems({
      content: "Short note.\n- [ ] finish this",
      privateLinks: ["2026-08-12", "Therapy notes"],
      unresolvedLinks: ["Missing"],
    });
    expect(problems.join(" ")).toContain("links into unpublished notes");
    expect(problems.join(" ")).toContain("2026-08-12");
    expect(problems.join(" ")).toContain("unresolved");
    expect(problems.join(" ")).toContain("open tasks");
    expect(problems.join(" ")).toContain("stub");
  });

  it("a clean, linked-up note has no problems", () => {
    const body = "A real paragraph with several words in it. ".repeat(8);
    expect(polishProblems({ content: body, privateLinks: [], unresolvedLinks: [] })).toEqual([]);
  });
});

describe("ledger diffing", () => {
  it("reports new and modified candidates, leaves screened ones alone", () => {
    const ledger: PublishLedger = {
      "a.md": { hash: 1, mtime: 100, state: "cleared", reasons: [] },
      "b.md": { hash: 2, mtime: 100, state: "held", reasons: ["x"] },
    };
    const changed = changedSince(ledger, [
      { path: "a.md", mtime: 100 }, // unchanged
      { path: "b.md", mtime: 200 }, // modified
      { path: "c.md", mtime: 50 }, // never screened
    ]);
    expect(changed.sort()).toEqual(["b.md", "c.md"]);
  });

  it("contentHash is stable and content-sensitive", () => {
    expect(contentHash("abc")).toBe(contentHash("abc"));
    expect(contentHash("abc")).not.toBe(contentHash("abd"));
  });
});
