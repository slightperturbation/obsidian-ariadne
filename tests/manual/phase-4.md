# Phase 4a — manual test script (refactoring engine)

Prereq: Phases 1–3 passing. These are **multi-file, vault-writing refactors** —
split and merge edit/delete existing notes, so they're previewed and
batch-undoable. A Claude key makes grouping/annotation smarter; without one,
split falls back to one-note-per-section and MoC to a flat list.

⚠️ Confirm you're in the **test-vault copy**, not real Syncd.

## 1. Semantic split — two passes

Split now branches on whether the note is structured. **Command:
Ariadne: Split this note into atomic notes.**

### 1a. Structuring pass (unstructured note → editable sections)
- [ ] Open a long, unstructured note (prose, few or no `##` headings) that
      clearly holds several ideas. Run Split.
- [ ] A **preview** shows the SAME note rewritten in place: a top callout
      ("Proposed split — edit these sections…"), your framing/intro text kept,
      and a `## <proposed title>` section per idea holding the clustered
      paragraphs (with an italic one-line description).
- [ ] **Content check:** every original paragraph is present — either under a
      section or left in place as framing. Nothing paraphrased or dropped
      (the model assigns paragraphs; it doesn't rewrite them).
- [ ] Accept → the note now has the proposed sections. Edit them: rename
      headings, move text between sections, delete a section you don't want.
- [ ] Undo reverts the restructuring in one step.

### 1b. Already atomic → refusal
- [ ] Open a short, single-idea note and run Split → a notice says it reads as
      a single atomic note and suggests adding `##` sections. No changes.

### 1c. Extraction pass (structured note → atomic files)
- [ ] On the note you structured in 1a (or any note with ≥2 `##` sections),
      run Split **again**.
- [ ] A **preview** shows the note becoming a Map-of-Content stub (intro kept,
      the "Proposed split" callout removed, a `## Contents` list of `[[child]]`
      links) plus one new child note per group — each `Part of [[Original]].`
      carrying its sections verbatim.
- [ ] **Content check:** every section lands in exactly one child (or back in
      the parent). Accept → children created (names auto-disambiguated on
      collision), original becomes the MoC. Child backlinks + Contents links
      resolve.
- [ ] **Undo** reverts the whole extraction — children trashed, original
      restored — in one step.
- [ ] Keyless: extraction still works via the per-section fallback; the
      structuring pass (1a) requires a model and says so if none is set.

**Typical flow:** unstructured note → Split (structure it) → edit the proposed
sections → Split again (extract to files).

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
