# Phase 1 — manual test script (desktop, dev vault)

Run against a **copy** of Syncd with Sync off. Build with `npm run build` (or
`npm run dev`), symlink/copy `main.js` + `manifest.json` + `styles.css` into
`<dev-vault>/.obsidian/plugins/ariadne/`, enable the plugin.

## 1. Load & index
- [ ] Enable Ariadne → no console errors on load.
- [ ] Open the Line (command: **Ariadne: Focus the Line**). The status glyph
      counts up (`N/M notes · indexing`) and settles at `M notes · idle`.
- [ ] While the initial index runs, type in a note — **no typing lag**.
- [ ] First run only: glyph shows `semantic loading…` while bge-small
      (~30 MB) downloads, then `semantic on`. Lexical search works the whole
      time. (Offline first run → `semantic fallback` instead; that's correct.)

## 2. Search (Layer 1 — Found)
- [ ] Type a word you know appears in note titles → results appear
      essentially instantly, titles before snippets you'd expect.
- [ ] Misspell it slightly (fuzzy) and type only a prefix → still found.
- [ ] Each row shows title, one-line snippet, and a 3-bar sparkline;
      hover the sparkline → tooltip reads `linked · recent · atomic`.
- [ ] Higher-confidence rows read visually stronger (opacity/weight).

## 3. Layers (Related)
- [ ] With `semantic on`: query a concept phrased differently from how any
      note words it (e.g. "note-taking method" when notes say "Zettelkasten")
      → a **Related** section surfaces semantically-near notes with no
      lexical match.

## 4. Keyboard
- [ ] ↑/↓ moves selection (wraps at the ends); selected row shows the accent
      bar.
- [ ] ↵ opens the selected note in the current pane; ⌘↵ in a new pane.
- [ ] With a note open for editing, focus the Line, select a result, ⌥↵ →
      a `[[link]]` is inserted at the cursor and focus returns to the editor.
- [ ] Esc in the Line returns focus to the editor.
- [ ] Mouse click on a row opens it; ⌘-click opens in a new pane.

## 5. Query grammar
- [ ] `in:Projects <word>` filters to that folder; `type:reference <word>`
      filters by frontmatter type; `since:2026-01-01 <word>` filters by mtime.

## 6. Incremental indexing
- [ ] Create a new note with a distinctive word → within ~a second it is
      findable in the Line.
- [ ] Edit an existing note to add a distinctive word → findable; the old
      content of that section no longer ranks.
- [ ] Rename that note → found under the new title; old title gone.
- [ ] Delete it → gone from results; note count in the glyph drops.

## 7. Persistence & lifecycle
- [ ] After the glyph goes idle, wait ~5 s →
      `.obsidian/plugins/ariadne/index/` contains `manifest.json`,
      `chunks-0.json`, `vectors-0.bin` (each file < 5 MB).
- [ ] Disable + re-enable the plugin (or restart Obsidian) → **warm start**:
      the glyph shows the full note count almost immediately, no full
      re-index; console (with debug logging on) says
      `warm start: N notes from snapshot` and a small stale diff.
- [ ] Edit a note while the plugin is disabled, re-enable → only that note
      re-indexes (stale diff catches it) and search finds the new content.
- [ ] Delete `manifest.json` from the index dir, reload the plugin → clean
      full rebuild, no errors (corruption tolerance).
- [ ] Command **Ariadne: Rebuild index** → glyph shows progress, ends idle,
      same note count.
- [ ] `app.emulateMobile(true)` (dev console) → plugin loads, Line opens as a
      drawer, search works. Then `app.emulateMobile(false)`.

## Perf spot-checks
- [ ] Keystroke → first painted results feels < 50 ms on the dev vault.
- [ ] Initial full index of the vault completes in a reasonable time and the
      app stays responsive throughout.

## Placement decision (for Dexter)
The Line currently docks in the **right sidebar**. The PRD wants it
front-and-center; options to try while living with it: right sidebar (as now),
a pinned main-area tab, or a future top-docked custom pane. Note which feels
right — this decides the Phase 2 layout work.
