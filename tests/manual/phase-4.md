# Phase 4a — manual test script (refactoring engine)

Prereq: Phases 1–3 passing. These are **multi-file, vault-writing refactors** —
split and merge edit/delete existing notes, so they're previewed and
batch-undoable. A Claude key makes grouping/annotation smarter; without one,
split falls back to one-note-per-section and MoC to a flat list.

⚠️ Confirm you're in the **test-vault copy**, not real Syncd.

## 1. Semantic split (the marquee feature)
- [ ] Open a long note with several `##` sections (or a `#` title + `##`
      sections). Run **Ariadne: Split this note into atomic notes**.
- [ ] A **preview** shows: the original note becoming a Map-of-Content stub
      (its intro kept, plus a `## Contents` list of `[[child]]` links), and one
      new child note per group — each starting `Part of [[Original]].` and
      carrying that group's sections verbatim.
- [ ] **Content check:** every section from the original appears in exactly one
      child (or, if the model left one out, back in the parent). Nothing is
      lost — scan the diffs.
- [ ] Accept → children are created (names auto-disambiguated if they collide),
      the original becomes the MoC. Open a child: its backlink to the parent
      resolves; the parent's Contents links resolve.
- [ ] **Undo:** *Ariadne: Undo last action* reverts the whole split — children
      removed (to trash), original restored — in one step.
- [ ] A note with <2 sections → notice "too few sections to split", no preview.
- [ ] With no key set: split still works via the per-section fallback (one
      child per `##`).

## 2. Map of Content
- [ ] Open a note with a clear neighborhood of related notes. Run
      **Ariadne: Generate Map of Content from related notes**.
- [ ] A new MoC note is created and opened directly (no preview — it's pure
      creation, like scaffolding). It has `type: moc`, a themed structure, and
      `[[links]]` to real neighborhood notes (no invented/hallucinated links).
- [ ] Its backlinks pane shows the member notes (Obsidian auto-backlinks).
- [ ] Undo removes it; a note with <2 related neighbors → notice, nothing made.

## 3. Merge near-duplicate
- [ ] Make two near-identical notes (copy one, tweak a line). Open one, run
      **Ariadne: Merge near-duplicate into this note**.
- [ ] A **preview** shows the current note gaining the other's body under a
      `## Merged from [[Other]]` heading, and the other note being deleted.
- [ ] Accept → content unioned into the kept note, the other trashed. Undo
      restores both.
- [ ] On a note with no close duplicate → notice "No near-duplicate found."
      (Merge only offers when cosine ≥ 0.9.)

## 4. Safety regression
- [ ] The stale-preview guard still bites: start a split preview, edit the
      original in another pane, Accept → refused (a file changed since preview).
- [ ] Cost cap still stops model calls once the session limit is hit (split/MoC
      then use their fallbacks).
- [ ] Phases 1–3 surfaces (search, Margin, ghost text, scaffold, weave) all
      still work; typing stays lag-free.

## Judgment calls to report back
1. Split grouping: does the model carve the note at sensible idea-boundaries?
   Are child titles good? Is the fallback (one-per-section) useful on its own?
2. MoC themes: coherent sub-groupings, or a flat dump?
3. Is preview-then-accept right for split/merge, or too heavy?
4. Merge threshold (0.9): too eager, too shy, about right?

---

**Deferred to Phase 4b** (filing subsystem): attachments sweep (move
root-dumped images/PDFs into `Supporting Files/`, rewrite embeds), Inbox
triage, stub/`Untitled` triage, and a backup/export hook before big sweeps.
