import { describe, expect, it } from "vitest";
import { placementVote, type PlacementVoter } from "../src/actions/placement";

const v = (folder: string, weight?: number): PlacementVoter => ({ folder, weight });

describe("placementVote", () => {
  it("a clear majority of exact parents wins", () => {
    expect(placementVote([v("EOW Wiki"), v("EOW Wiki"), v("1 Zettelkasten/102 Zettels")])).toBe(
      "EOW Wiki",
    );
  });

  it("no exact majority generalizes one level up and re-votes", () => {
    // Split across sibling subfolders — their shared parent carries the vote.
    expect(
      placementVote([
        v("1 Zettelkasten/102 Zettels - Concepts"),
        v("1 Zettelkasten/103 References and Sources"),
        v("EOW Wiki"),
      ]),
    ).toBe("1 Zettelkasten");
  });

  it("returns null when the vault genuinely disagrees (root can't win)", () => {
    expect(placementVote([v("A"), v("B")])).toBeNull();
    expect(placementVote([v(""), v(""), v("")])).toBeNull();
  });

  it("needs at least two voters — one referrer is a coincidence", () => {
    expect(placementVote([v("EOW Wiki")])).toBeNull();
    expect(placementVote([])).toBeNull();
  });

  it("weights tip an otherwise even split", () => {
    expect(placementVote([v("EOW Wiki", 0.9), v("Projects", 0.2)])).toBe("EOW Wiki");
  });

  it("excluded folders never vote, including their subfolders", () => {
    expect(placementVote([v("Inbox"), v("Inbox"), v("EOW Wiki"), v("EOW Wiki")], ["Inbox"])).toBe(
      "EOW Wiki",
    );
    expect(placementVote([v("Archive/2025"), v("Archive/2025")], ["Archive"])).toBeNull();
  });

  it("exclusion is prefix-safe: 'Inbox' does not exclude 'Inbox Ideas'", () => {
    expect(placementVote([v("Inbox Ideas"), v("Inbox Ideas")], ["Inbox"])).toBe("Inbox Ideas");
  });

  it("a bare 50/50 split is not a majority", () => {
    expect(placementVote([v("A/X"), v("A/X"), v("B/Y"), v("B/Y")])).toBeNull();
  });

  it("generalization stops at the deepest folder with a real majority", () => {
    // Three voters under Research, one elsewhere: Research/Papers alone is
    // only half — the vote settles on Research, not the vault root.
    expect(
      placementVote([
        v("Research/Papers"),
        v("Research/Papers"),
        v("Research/Ideas"),
        v("Personal/Misc"),
      ]),
    ).toBe("Research");
  });
});
