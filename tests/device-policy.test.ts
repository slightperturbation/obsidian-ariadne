import { describe, expect, it } from "vitest";
import { devicePolicy } from "../src/core/device";
import { IndexManager } from "../src/index/manager";
import { HashEmbedder } from "../src/index/embeddings/hash-embedder";
import type { SourceNote } from "../src/core/types";

const note = (path: string, content: string): SourceNote => ({
  path,
  title: path.replace(/\.md$/, ""),
  content,
  mtime: 1,
  folder: "",
});

describe("devicePolicy", () => {
  it("makes a desktop the index owner and a phone a consumer", () => {
    const desktop = devicePolicy({ isMobile: false, deviceRole: "auto", enableSemantic: true });
    expect(desktop).toMatchObject({ role: "owner", writesIndex: true, loadsModel: true });

    const phone = devicePolicy({ isMobile: true, deviceRole: "auto", enableSemantic: true });
    expect(phone).toMatchObject({ role: "consumer", writesIndex: false, loadsModel: false });
    // Touch affordances key off the device, not the role.
    expect(phone.touch).toBe(true);
  });

  it("lets the user pin either role on either device", () => {
    // An iPad-only user with no desktop: the tablet has to own the index.
    const tablet = devicePolicy({ isMobile: true, deviceRole: "owner", enableSemantic: true });
    expect(tablet).toMatchObject({ role: "owner", writesIndex: true, loadsModel: true });
    expect(tablet.touch).toBe(true);

    // A laptop that should defer to the desktop rather than fight it over Sync.
    const laptop = devicePolicy({ isMobile: false, deviceRole: "consumer", enableSemantic: true });
    expect(laptop).toMatchObject({ role: "consumer", writesIndex: false, loadsModel: false });
  });

  it("never loads a model when semantic search is off, but still owns the index", () => {
    const off = devicePolicy({ isMobile: false, deviceRole: "auto", enableSemantic: false });
    expect(off.loadsModel).toBe(false);
    expect(off.writesIndex).toBe(true);
  });
});

describe("consumer device: semantic relatedness with no embedder", () => {
  /** Index on an "owner", then hand the snapshot to a model-less "consumer". */
  async function ownerThenConsumer(): Promise<IndexManager> {
    const owner = new IndexManager(new HashEmbedder(64));
    for (const n of [
      note("cats.md", "Cats are small carnivorous mammals often kept as pets."),
      note("dogs.md", "Dogs are loyal domesticated mammals kept as pets."),
      note("taxes.md", "Quarterly estimated tax payments are due in April."),
      note("pets.md", "Domesticated mammals kept as pets need daily care."),
    ]) {
      await owner.indexNote(n);
    }
    const consumer = new IndexManager();
    consumer.restore(await owner.snapshot());
    return consumer;
  }

  it("cannot embed text but still holds the owner's vectors", async () => {
    const consumer = await ownerThenConsumer();
    expect(consumer.canEmbedText()).toBe(false);
    expect(consumer.hasStoredVectors()).toBe(true);
  });

  it("answers 'related to this note' from stored vectors alone", async () => {
    const consumer = await ownerThenConsumer();
    const related = await consumer.relatedToPath("cats.md");
    expect(related.length).toBeGreaterThan(0);
    // Never suggests the note to itself.
    expect(related.map((r) => r.path)).not.toContain("cats.md");
    // And it is genuinely semantic: the other mammal note outranks the tax one.
    const paths = related.map((r) => r.path);
    expect(paths).toContain("dogs.md");
    if (paths.includes("taxes.md")) {
      expect(paths.indexOf("dogs.md")).toBeLessThan(paths.indexOf("taxes.md"));
    }
  });

  it("carries a cosine, so the Margin's floor still applies", async () => {
    const consumer = await ownerThenConsumer();
    const related = await consumer.relatedToPath("cats.md");
    expect(related[0].cosine).toBeTypeOf("number");
    expect(await consumer.relatedToPath("cats.md", { minCosine: 0.999 })).toHaveLength(0);
  });

  it("returns nothing for a note the owner never indexed", async () => {
    const consumer = await ownerThenConsumer();
    expect(await consumer.relatedToPath("never-seen.md")).toEqual([]);
  });

  it("free-text search degrades to lexical rather than failing", async () => {
    const consumer = await ownerThenConsumer();
    expect((await consumer.query("mammals")).map((h) => h.path)).toContain("cats.md");
  });

  it("a local edit costs that note its vectors and nothing else", async () => {
    const consumer = await ownerThenConsumer();
    const before = await consumer.relatedToPath("dogs.md");
    expect(before.map((r) => r.path)).toContain("pets.md");

    // Editing on the phone: lexical-only re-index, no model to embed with.
    await consumer.indexNote(note("cats.md", "Cats. Now with extra text typed on a phone."));

    // The edited note stays findable by word...
    expect((await consumer.query("phone")).map((h) => h.path)).toContain("cats.md");
    // ...but it has no vectors, so it drops out of stored-vector relatedness
    // until the owner re-indexes it. That is the honest degradation.
    expect(await consumer.relatedToPath("cats.md")).toEqual([]);
    expect((await consumer.relatedToPath("dogs.md")).map((r) => r.path)).not.toContain("cats.md");
    // Every other note's vectors are untouched.
    expect((await consumer.relatedToPath("dogs.md")).map((r) => r.path)).toContain("pets.md");
  });
});
