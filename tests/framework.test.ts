import { describe, expect, it } from "vitest";
import {
  ActionExecutor,
  ConflictError,
  type ActionProposal,
  type VaultIO,
} from "../src/actions/framework";

function memVault(initial: Record<string, string> = {}): VaultIO & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  return {
    files,
    exists: async (p) => files.has(p),
    read: async (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`not found: ${p}`);
      return v;
    },
    create: async (p, c) => {
      if (files.has(p)) throw new Error(`exists: ${p}`);
      files.set(p, c);
    },
    modify: async (p, c) => {
      if (!files.has(p)) throw new Error(`not found: ${p}`);
      files.set(p, c);
    },
    delete: async (p) => {
      if (!files.delete(p)) throw new Error(`not found: ${p}`);
    },
  };
}

const createProposal = (path: string, content: string): ActionProposal => ({
  title: `create ${path}`,
  changes: [{ type: "create", path, after: content }],
});

describe("ActionExecutor", () => {
  it("applies a multi-file action and undoes it in one step", async () => {
    const vault = memVault({ "a.md": "original a", "b.md": "original b" });
    const executor = new ActionExecutor(vault);

    await executor.apply({
      title: "weave",
      changes: [
        { type: "modify", path: "a.md", before: "original a", after: "a with link" },
        { type: "modify", path: "b.md", before: "original b", after: "b with backlink" },
      ],
    });
    expect(vault.files.get("a.md")).toBe("a with link");
    expect(vault.files.get("b.md")).toBe("b with backlink");

    const undone = await executor.undoLast();
    expect(undone?.title).toBe("weave");
    expect(vault.files.get("a.md")).toBe("original a");
    expect(vault.files.get("b.md")).toBe("original b");
    expect(await executor.undoLast()).toBeNull();
  });

  it("refuses to apply when a file changed since the preview", async () => {
    const vault = memVault({ "a.md": "edited meanwhile" });
    const executor = new ActionExecutor(vault);
    await expect(
      executor.apply({
        title: "stale",
        changes: [{ type: "modify", path: "a.md", before: "as previewed", after: "x" }],
      }),
    ).rejects.toThrow(ConflictError);
    expect(vault.files.get("a.md")).toBe("edited meanwhile");
  });

  it("refuses to create over an existing file", async () => {
    const vault = memVault({ "a.md": "here" });
    const executor = new ActionExecutor(vault);
    await expect(executor.apply(createProposal("a.md", "clobber"))).rejects.toThrow(
      ConflictError,
    );
  });

  it("rolls back already-applied changes when a later step fails", async () => {
    const vault = memVault({ "a.md": "original a" });
    const executor = new ActionExecutor(vault);
    await expect(
      executor.apply({
        title: "partial",
        changes: [
          { type: "modify", path: "a.md", before: "original a", after: "modified a" },
          // Fails at apply time: create() throws if the path appears between
          // validate and apply — simulate by pre-inserting after validate via
          // a change that creates the same path twice.
          { type: "create", path: "new.md", after: "x" },
          { type: "create", path: "new.md", after: "y" },
        ],
      }),
    ).rejects.toThrow();
    // First change was rolled back; the successfully created file removed.
    expect(vault.files.get("a.md")).toBe("original a");
    expect(vault.files.has("new.md")).toBe(false);
  });

  it("undo validates too: blocked if the file changed after the action", async () => {
    const vault = memVault({ "a.md": "v1" });
    const executor = new ActionExecutor(vault);
    await executor.apply({
      title: "edit",
      changes: [{ type: "modify", path: "a.md", before: "v1", after: "v2" }],
    });
    vault.files.set("a.md", "manually edited after action");
    await expect(executor.undoLast()).rejects.toThrow(ConflictError);
    // Still on the stack — user can resolve and retry.
    expect(executor.undoCount).toBe(1);
  });

  it("undo of a delete restores content; undo of a create deletes", async () => {
    const vault = memVault({ "gone.md": "precious" });
    const executor = new ActionExecutor(vault);

    await executor.apply({
      title: "delete",
      changes: [{ type: "delete", path: "gone.md", before: "precious" }],
    });
    expect(vault.files.has("gone.md")).toBe(false);
    await executor.undoLast();
    expect(vault.files.get("gone.md")).toBe("precious");

    await executor.apply(createProposal("new.md", "hello"));
    expect(vault.files.get("new.md")).toBe("hello");
    await executor.undoLast();
    expect(vault.files.has("new.md")).toBe(false);
  });
});
