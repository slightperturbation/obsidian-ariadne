# Phase 3 — manual test script (desktop, dev vault)

Prereq: Phases 1–2 passing. **This is the first phase that writes to the
vault** — every write is preview → Accept → undoable. Set a Claude API key
(Settings → Ariadne → Models → Claude API key) to exercise the model path;
without one, actions fall back to plain templates and bare links.

⚠️ Confirm you're in the **test-vault copy**, not real Syncd, before accepting
any write.

## 0. Safety invariant (do this first)
- [ ] With NO key set: everything from Phases 1–2 still works and nothing
      writes to the vault unprompted.
- [ ] The glyph shows `brain ready` once a key is set (or `brain $0.00` after
      the first call), and no brain segment when the key is blank.

## 1. New scaffolded note
- [ ] Command **Ariadne: New scaffolded note** → type a seed ("Environmental
      complexity drives morphological complexity") → a **preview modal** opens
      showing the create-diff (frontmatter, key-idea bullets, section
      headings, Related links).
- [ ] The scaffold is STRUCTURE ONLY — headings and telegraphic bullets, never
      a finished paragraph in your voice.
- [ ] The suggested home folder is one of your real folders (Johnny-Decimal
      folders included), and Related links point at real notes.
- [ ] **Accept** → the note is created and opened. **Cancel/Esc** on a fresh
      run → nothing is created.
- [ ] The glyph's brain cost ticks up after the model call.

## 2. Link weaving
- [ ] Open a note, place the cursor mid-sentence. In the **Line**, search a
      related note, select it, press **⇧↵** → preview shows TWO diffs: a
      `[[link]]` inserted at your cursor, and a backlink bullet added under the
      target's "## Related" (with a connective phrase if the model is on).
- [ ] Accept → both files update; the link lands at the cursor, the backlink
      under Related. Open the target to confirm the backlink.
- [ ] Same via the **Margin**: ⇧-click a related card → same weave preview.
- [ ] Weaving a note to itself, or with no note open, shows a notice and does
      nothing.

## 3. Undo (the load-bearing safety net)
- [ ] After accepting a weave, run **Ariadne: Undo last action** → BOTH files
      revert in one step. A notice confirms.
- [ ] Undo again → "Nothing to undo."
- [ ] Create a note, then edit it by hand, then Undo the creation → it should
      still remove the note (creation undo = delete; goes to Obsidian trash).
- [ ] **Conflict guard:** accept a weave, then manually edit one of the two
      files, then Undo → the undo is BLOCKED with a notice (won't clobber your
      newer edit). The action stays undoable once you revert your manual edit.

## 4. Stale-preview guard
- [ ] Open the New-note preview, and (in another pane, before accepting)
      create a note at the same path the scaffold would use. Accept → the
      action is refused with a notice ("already exists"), no overwrite.

## 5. Cost cap
- [ ] Set the session cost limit low (Settings → Ariadne → Session cost limit
      = 0.01). Trigger a couple of scaffolds → once the session spend crosses
      the limit, further model calls stop with a notice; actions still work
      but fall back to templates/bare links.
- [ ] Set it back to 2 (or 0 to disable).

## 6. Regression sweep
- [ ] Line search, ⌥↵ link insert, Margin cards, ghost text — all still work.
- [ ] Typing stays lag-free; no model call ever happens on a keystroke (only
      on ⇧↵ / the create row / the command).
- [ ] Disable + re-enable the plugin: no console errors; index warm-starts.

## Judgment calls to report back
1. Scaffold quality: right home folder? Useful key-idea bullets? Too much / too
   little structure?
2. Connective phrases: do they read like your marginalia, or generic?
3. Is the preview → accept friction right, or too heavy for the small actions
   (bare link weave)?
