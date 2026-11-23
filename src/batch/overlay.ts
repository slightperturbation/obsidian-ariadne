import type { FileChange } from "../actions/framework";
import type { VaultAccess } from "../chat/tools";

/**
 * The vault as one note's agent sees it while it works: the real vault, with
 * the changes it has already decided on laid over it. An edit, then a move,
 * then a tag on the moved note each see what the step before left — and the
 * whole list is applied to the real vault only when the agent is done.
 */
export function overlayVault(base: VaultAccess, opts: { journal: (path: string) => boolean; main?: string }): {
  vault: VaultAccess;
  changes: FileChange[];
  record(changes: FileChange[]): void;
} {
  /**
   * What is at a path now, as decided so far. Absent: as in the vault.
   * null: nothing. { text }: this text. { at }: the note that is really at
   * `at` in the vault (it has been moved here, its text untouched).
   */
  type Slot = null | { text: string } | { at: string };
  const slots = new Map<string, Slot>();
  /** Where a moved note came from, so its own properties still decide its privacy. */
  const origin = new Map<string, string>();
  const changes: FileChange[] = [];
  const originOf = (p: string): string => origin.get(p) ?? p;
  /** 0 shareable, 1 local-only, 2 journal, 3 sealed. A new note (note "") is ranked by its folder alone. */
  const rankAt = (note: string, at: string): number => {
    if (base.rankAt) return base.rankAt(note ? originOf(note) : "", at);
    const level = base.levelAt(note ? originOf(note) : "", at);
    const r = level === "sealed" ? 3 : level === "local" ? 1 : 0;
    return opts.journal(at) ? Math.max(r, 2) : r;
  };

  const vault: VaultAccess = {
    ...base,
    read: async (p) => {
      const s = slots.get(p);
      if (s === undefined) return base.read(p);
      if (s === null) return undefined;
      return "text" in s ? s.text : base.read(s.at);
    },
    exists: (p) => {
      const s = slots.get(p);
      return s === undefined ? base.exists(p) : s !== null;
    },
    // No note more private than the one being worked on is shown: what the agent never sees, it cannot copy out.
    // (Its own note it always sees, wherever it has moved it.)
    readable: (p) => {
      const may = base.readable(originOf(p));
      if (!may.ok || opts.main === undefined || originOf(p) === opts.main) return may;
      if (rankAt(p, p) > rankAt(opts.main, opts.main)) return { ok: false, why: "it is more private than the note this batch step is for" };
      return may;
    },
    rankAt: (note, at) => rankAt(note, at),
    // A batch may put the owner's own notes into the journal (a move or a merge); what is sealed stays out of reach.
    writable: (p) => {
      const may = base.writable(p);
      if (may.ok || !opts.journal(p)) return may;
      return base.levelAt(p, p) === "sealed" ? may : { ok: true };
    },
    // The journal counts as private here whatever its folder's level: nothing leaves it by a move or a merge.
    // Changing a note in code, unseen by the model (a merge target, a relinked note): the chat's own walls, no cap.
    mayChange: (p) => base.readable(originOf(p)),
    levelAt: (note, at) => {
      const level = base.levelAt(originOf(note), at);
      return level === "shareable" && opts.journal(at) ? "local" : level;
    },
    linksTo: base.linksTo ? (p) => base.linksTo!(originOf(p)) : undefined,
    resolve: (name) => {
      const bare = name.replace(/^\[\[|\]\]$/g, "").split("|")[0]!.trim();
      for (const p of [bare, `${bare}.md`]) {
        const s = slots.get(p);
        if (s !== undefined) return s === null ? undefined : p;
      }
      const found = base.resolve(name);
      return found !== undefined && slots.get(found) === null ? undefined : found;
    },
    notes: () => {
      const listed = base.notes().filter((n) => slots.get(n.path) !== null);
      for (const [p, s] of slots) {
        if (s !== null && !listed.some((n) => n.path === p)) {
          listed.push({ path: p, mtime: Date.now(), tags: base.notes().find((n) => n.path === originOf(p))?.tags ?? [] });
        }
      }
      return listed;
    },
    isJournal: (p) => opts.journal(p),
  };

  const record = (list: FileChange[]): void => {
    for (const c of list) {
      changes.push(c);
      if (c.type === "move") {
        const to = c.to ?? "";
        const here = slots.has(c.path) ? slots.get(c.path)! : { at: c.path };
        slots.set(to, here);
        slots.set(c.path, null);
        origin.set(to, originOf(c.path));
      } else if (c.type === "delete") {
        slots.set(c.path, null);
      } else {
        slots.set(c.path, { text: c.after ?? "" });
      }
    }
  };

  return { vault, changes, record };
}
