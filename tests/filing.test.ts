import { describe, expect, it } from "vitest";
import {
  isAttachmentExt,
  planAttachmentSweep,
  isEmptyNote,
  buildDeleteProposal,
  type AttachmentFile,
} from "../src/actions/filing";

describe("isAttachmentExt", () => {
  it("recognizes image/pdf/av extensions, case-insensitive", () => {
    expect(isAttachmentExt("PNG")).toBe(true);
    expect(isAttachmentExt("pdf")).toBe(true);
    expect(isAttachmentExt("mp4")).toBe(true);
    expect(isAttachmentExt("md")).toBe(false);
    expect(isAttachmentExt("base")).toBe(false);
  });
});

describe("planAttachmentSweep", () => {
  const files: AttachmentFile[] = [
    { path: "shot.png", name: "shot.png", extension: "png", parentPath: "/" },
    { path: "doc.pdf", name: "doc.pdf", extension: "pdf", parentPath: "/" },
    { path: "notes.md", name: "notes.md", extension: "md", parentPath: "/" }, // not an attachment
    { path: "Photos/keep.jpg", name: "keep.jpg", extension: "jpg", parentPath: "Photos" }, // not root
  ];

  it("moves only root attachments into the folder", () => {
    const moves = planAttachmentSweep(files, "Supporting Files", () => false);
    expect(moves.map((m) => m.fromPath)).toEqual(["shot.png", "doc.pdf"]);
    expect(moves[0].toPath).toBe("Supporting Files/shot.png");
  });

  it("disambiguates targets against the vault and within the batch", () => {
    const dupes: AttachmentFile[] = [
      { path: "a/img.png", name: "img.png", extension: "png", parentPath: "/" },
      { path: "img.png", name: "img.png", extension: "png", parentPath: "/" },
    ];
    // Pretend "Supporting Files/img.png" already exists in the vault.
    const taken = new Set(["Supporting Files/img.png"]);
    const moves = planAttachmentSweep(dupes, "Supporting Files", (p) => taken.has(p));
    expect(moves[0].toPath).toBe("Supporting Files/img 2.png");
    expect(moves[1].toPath).toBe("Supporting Files/img 3.png");
  });
});

describe("isEmptyNote", () => {
  it("treats blank and bookkeeping-frontmatter-only notes as empty", () => {
    expect(isEmptyNote("")).toBe(true);
    expect(isEmptyNote("   \n\n")).toBe(true);
    expect(isEmptyNote("---\ntype: note\n---\n")).toBe(true);
    expect(isEmptyNote("---\ntype: note\ncreated: 2026-07-22\n---\n")).toBe(true);
  });

  it("never treats a metadata-only note as empty", () => {
    // A Dataview/Bases row is content, even with no prose body.
    expect(
      isEmptyNote("---\ntype: book\nauthor: Frank Herbert\nrating: 5\n---\n"),
    ).toBe(false);
    expect(isEmptyNote("---\naliases: [the loop]\n---\n")).toBe(false);
  });

  it("never treats a note with a body as empty", () => {
    expect(isEmptyNote("---\ntype: note\n---\n\nreal content")).toBe(false);
    expect(isEmptyNote("body")).toBe(false);
  });
});

describe("buildDeleteProposal", () => {
  it("makes a delete change per note with its content as the conflict anchor", () => {
    const proposal = buildDeleteProposal("Clean up empties", [
      { path: "Untitled.md", content: "" },
      { path: "Untitled 1.md", content: "---\n---\n" },
    ]);
    expect(proposal.changes).toHaveLength(2);
    expect(proposal.changes.every((c) => c.type === "delete")).toBe(true);
    expect(proposal.changes[0]).toEqual({ type: "delete", path: "Untitled.md", before: "" });
  });
});
