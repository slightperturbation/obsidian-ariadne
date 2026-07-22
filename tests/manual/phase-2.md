# Phase 2 — manual test script (desktop, dev vault)

Prereq: Phase 1 passing (`semantic on` in the Line's glyph). Reload the
plugin after building so the new views and editor extension register.

## 1. The Margin (related cards)
- [ ] Command **Ariadne: Open the Margin** → a card panel opens in the right
      sidebar (tabbed alongside the Line is fine).
- [ ] Open a substantial note and click into a paragraph → within ~a second
      the Margin shows up to 5 related notes. The current note itself never
      appears.
- [ ] Type a few sentences about a *different* topic in a new paragraph →
      after you pause, the cards change to follow the new topic.
- [ ] Cards show confidence visually: top matches solid, weak ones faint.
- [ ] Click a card → opens the note. ⌥-click → inserts `[[link]]` at your
      cursor instead. ⌘-click → opens in a new pane.
- [ ] Cursor on a blank line → cards fall back to whole-note context (not
      empty, not erratic).

## 2. Ghost link suggestions
- [ ] In a note, write a sentence clearly about another note's topic (e.g.
      write about morphological complexity if you have the Auerboch notes),
      then **pause typing** with the cursor at the end of the word/sentence.
- [ ] A faint `[[Note title]]` appears at the cursor — accent-colored, ~40%
      opacity, clearly not real text.
- [ ] **Tab** accepts: the link becomes real text, cursor lands after it,
      undo (⌘Z) removes it like any typed text.
- [ ] **Esc** dismisses — and the same suggestion does NOT come back while
      you keep editing that paragraph (only after materially changing it).
- [ ] Type any character while a ghost is showing → it vanishes immediately.
- [ ] A note already `[[linked]]` in the file is never suggested again.
- [ ] No suggestions appear mid-word or while typing inside `[[…` yourself.

## 3. Conflict checks (the risk-register items)
- [ ] With NO ghost visible: Tab still indents / outdents lists normally, and
      Esc behaves as before (e.g. exits search). Nothing swallowed.
- [ ] In a bullet list, get a ghost, press Tab → the link is accepted (list
      indent does NOT trigger).
- [ ] If you use vim mode: Esc with a ghost visible both dismisses it AND
      still returns to normal mode (single press).
- [ ] IME check if convenient (e.g. Japanese input): composing text is never
      interrupted by a suggestion; Tab during composition goes to the IME.
- [ ] Reading view: no ghosts, no errors.

## 4. Tuning (Settings → Ariadne → Margin)
- [ ] "Suggestion reticence" slider: drop to 0.5 → suggestions get chatty;
      raise to 0.9 → near-silence. Find where it feels like marginalia and
      note the value.
- [ ] Both toggles work live: disabling ghost text stops suggestions;
      disabling the Margin freezes the cards.

## 5. Regression sweep
- [ ] The Line still searches, opens, and inserts links as in Phase 1.
- [ ] Typing stays lag-free with Margin open + ghost enabled (both piggyback
      on one typing-pause watcher; nothing should run per keystroke).
- [ ] Plugin disable → re-enable: no console errors, everything returns.

## Judgment calls to report back
1. Does the 600 ms typing-pause feel right, or eager/laggy?
2. Is 0.7 reticence the right default for your vault?
3. Do the Margin's faint cards earn their place, or distract?
