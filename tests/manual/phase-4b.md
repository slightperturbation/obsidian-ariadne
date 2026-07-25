# Phase 4b — manual test script (filing subsystem)

Prereq: Phases 1–4a passing. These are **batch, vault-writing** filing actions,
previewed (as a file list) and undoable via the one *Undo last Ariadne action* command.

⚠️ Confirm you're in the **test-vault copy**, not real Syncd.

## 1. Attachments sweep
- [ ] Set **Settings → Ariadne → Filing → Attachments folder** (default
      "Supporting Files").
- [ ] Have a few image/PDF files dumped in the vault **root**, and embed one in
      a note (`![[shot.png]]` or `![](shot.png)`).
- [ ] Run **Ariadne: Sweep root attachments into the attachments folder** → a
      **list preview** shows `name → Supporting Files/` for each root
      attachment. Non-root attachments and markdown/base files are not listed.
- [ ] Apply → the files move into the folder (created if missing). Open the note
      that embedded one: the embed still resolves (Obsidian rewrote the link).
- [ ] Name collisions (two `img.png`, or one already in the folder) get
      disambiguated (`img 2.png`), never overwritten.
- [ ] **Undo last Ariadne action** → the files move back to root; embeds still resolve.
- [ ] Run again with a clean root → notice "No root-level attachments to
      sweep."

## 2. Empty-note cleanup
- [ ] Create a couple of empty notes (blank, or frontmatter/whitespace only) —
      e.g. leftover `Untitled.md`, a zero-byte note.
- [ ] Run **Ariadne: Clean up empty notes** → a **list preview** (styled as
      destructive) shows their paths. Notes with real content are NOT listed.
- [ ] Delete → they go to trash. **Undo last Ariadne action** restores them.
- [ ] Run with no empties → notice "No empty notes found."

## 3. Safety
- [ ] Both sweeps are previewed — Cancel/Esc does nothing.
- [ ] Attachments-move and empty-delete both undo in one step via the same
      *Undo last Ariadne action* command as split/merge/scaffold (shared undo stack).
- [ ] Phases 1–4a surfaces all still work; typing stays lag-free.

## Judgment calls to report back
1. Is targeting **root-only** attachments the right scope, or should it also
   pull attachments from other non-attachment folders?
2. Empty-note definition (frontmatter/whitespace-only) — right, too aggressive,
   too shy?

---

**Deferred to Phase 4c** (the subjective filing): Inbox triage (per item:
elaborate / merge / archive), `Untitled`-with-content renaming (title + home
suggestion), and a backup/export hook before very large sweeps.
