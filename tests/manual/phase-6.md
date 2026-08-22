# Phase 6 — manual test script (tension/echo, serendipity)

Prereq: Phases 1–5 passing on desktop. Claude API key configured (tension
classification needs it; echoes don't).

⚠️ Confirm you're in the **test-vault copy**, not real Syncd.

## 1. Echo — "you've said this before" (free, no API)

- [ ] Pick an existing indexed note with a clear claim. In a **different**
      note, retype that claim near-verbatim as a full paragraph (80+ chars),
      then pause.
- [ ] The Margin shows the note as an **echo** card: small-caps `echo` label,
      italic snippet, above the ordinary related cards.
- [ ] The same note does **not** also appear as a plain related card below
      (one note, one card).
- [ ] Add a `[[link]]` to that note in your draft → the echo card disappears
      (the connection is made; re-announcing is nagging).
- [ ] With **no API key** set, echoes still work — they're pure cosine.

## 2. Tension — "this disagrees with…" (classified, cached, budgeted)

- [ ] Write a paragraph that **contradicts** an existing note — same topic,
      opposite position (e.g. if a note says spaced repetition aids transfer,
      write that its transfer benefits are overstated). Pause.
- [ ] Within a second or two (one background Haiku call), a **tension** card
      appears: accent-colored `tension` label, the model's one-line
      explanation in italics naming the *specific* disagreement.
- [ ] The glyph's session cost ticks up by a fraction of a cent.
- [ ] Keep typing more of the same paragraph → **no further API calls** for
      that pair (watch cost; the verdict is cached across small edits).
- [ ] Write a paragraph merely *related* to a note (same topic, no stance
      conflict) → **no tension card**. "Neither" stays silent; the note shows
      as an ordinary related card only.
- [ ] A note you already `[[link]]` can still produce a tension card —
      contradicting a note you cite is exactly the moment to be told.

## 3. Dismissal and modes

- [ ] Click the `×` on a tension/echo card → it disappears and stays gone for
      this note+target pair for the rest of the session, including after more
      typing.
- [ ] The card itself still acts like any row: click opens the note,
      ⌥-click inserts a link, ⇧-click weaves.
- [ ] **Settings → Margin → Tension and echo cards → Off** → no cards, no
      API calls. **Eager** → cards appear for less-close matches (wider band,
      up to 4 findings).
- [ ] Set the **session cost limit** very low (e.g. $0.01), spend past it
      (e.g. one weave), then write a contradicting paragraph → no error
      appears; tension checks just stop (console: "tension checks stopped").
      Echoes still work.

## 4. Serendipity dials

- [ ] **Margin serendipity** at 1.0 → Margin cards render bolder (more
      prominent tier); at 0.0 → the same cards render fainter. The *set* of
      cards never changes — emphasis only.
- [ ] **Search serendipity** does the same for the search results' Related
      layer, independently.
- [ ] Both at 0.5 → identical to pre-Phase-6 rendering.

## Known limits (not bugs)

- Tension/echo runs only on devices that can embed text (the index owner).
  Readers don't run it — it's a writing-desk feature.
- At most ~60 classification calls per session, hard cap, on top of the cost
  limit. After that, tension goes quiet; echoes continue.
- A tension card reflects the model's judgment of two excerpts; it can be
  wrong. That's why it links the note — the card is an invitation to look,
  not a verdict.

## 5. Panel persistence

- [ ] Close and reopen Obsidian (or hot-reload the plugin) → the Ariadne
      panel re-appears in the right sidebar on its own, without stealing
      focus from the editor.

## 6. Local Gemma route (requires the home box awake)

- [ ] Start an OpenAI-compatible server (Ollama: `ollama serve` with
      gemma4:26b pulled; or LM Studio). Set **Settings → Models → Local model
      URL** (e.g. `http://localhost:11434/v1`) and the model name.
- [ ] Weave a link (⇧↵) → glyph shows `brain local`; session cost does
      **not** increase (the fragment came from the box, free).
- [ ] Run *Split this note* → glyph shows `brain $…` — quality-sensitive
      tasks stay on Claude under Automatic.
- [ ] Stop the local server, weave again → works seamlessly via Claude
      (console notes the local failure + retry; no visible error).
- [ ] **Routing → Cloud only** → everything on Claude regardless.
      **Local when reachable** → even Split uses the box (quality caveat is
      yours to judge).
- [ ] With NO Claude API key but the box awake → weaving and tension checks
      still work, `brain local`.

## 7. Incumbent retirement

- [ ] With Smart Connections and/or Omnisearch enabled, run **Ariadne: Retire
      replaced plugins** → a modal lists each, with what Ariadne covers
      instead, and per-item **Disable** buttons. Nothing happens without a
      click.
- [ ] Click Disable → the plugin turns off (verify in Community plugins —
      and note it's re-enableable there, this is the ordinary toggle).
- [ ] If `.smart-env/` exists, a **Trash .smart-env/** button appears →
      clicking moves it to the *system* trash (recoverable in Finder).
- [ ] With neither installed, the modal says there's nothing to retire.

## 8. Inbox triage + untitled notes (4c)

- [ ] Put a few notes in `Inbox/`: one empty-ish stub, one near-copy of an
      existing note, one genuine fragment of thinking, one stale clipping.
- [ ] Run **Triage Inbox** → one row per note, each with a proposed
      disposition and terse reason: the stub says *archive — effectively
      empty*, the near-copy says *merge — near-duplicate of X*, the live
      fragment says *elaborate*.
- [ ] **Archive** moves the note to `Archive/` — *Undo last action* brings it
      back. **Merge…** opens the note and runs the normal merge flow with its
      preview. **Open** just opens it (elaborating is writing, not a button).
- [ ] Create `Untitled.md` and `Untitled 2.md` with content (one with a
      heading, one without). Run **Resolve untitled notes** → proposed titles:
      the heading verbatim for the first; a model-proposed title for the
      second (or its first line). **Rename** renames in place — links to the
      note are rewritten — and is undoable.
- [ ] A table-heavy note: search for text from a table row → the snippet
      shows an intact row, not a shredded fragment.

## 9. Journaling fit (use review)

- [ ] **Margin follows reading.** Click a [[link]] inside a note (same pane)
      → the Margin updates to the new note without any edit. Chain three
      links; it keeps up.
- [ ] **Daily notes don't crowd.** In today's daily note, write about a topic
      you have BOTH a permanent note and old journal mentions of → the
      permanent note ranks above the dated entries in the Margin; the dated
      entries still appear, lower.
- [ ] **Ghost never suggests a date.** Ghost text offers [[Idea]] links but
      never [[2026-07-20]].
- [ ] **Capture a thought** (command) → type a sentence → an Inbox note
      exists, titled from your words, instantly — no API call, no dialogs
      beyond the one prompt. *Undo last action* removes it.
- [ ] **Promote selection to a note**: in a daily note, select a good line
      (or just stand in the paragraph) and run it → an Inbox note is created
      with the text + "— promoted from [[the daily]]", and " [[title]]"
      appears after the passage in the journal. The journal text itself is
      untouched. ⌘Z removes the inserted link; *Undo last action* removes
      the note.

## 10. Wanted topics + recurring themes

- [ ] **Wanted.** Have ≥2 notes link to a [[Topic]] that doesn't exist →
      a quiet **Wanted** section appears at the panel foot: "Topic ·
      wanted by 2". Click → the scaffolded note is created (undoable).
      × dismisses it for the session. A topic with only ONE dangling
      reference never appears.
- [ ] **Themes.** Write 3+ dated entries circling one idea that has no
      permanent note. Run **Find recurring journal themes** → a row names
      the theme (in your vocabulary), says "N entries · no permanent note
      nearby". **Create note** scaffolds it seeded from your own journal
      excerpts; **Open latest** jumps to the newest entry.
- [ ] Once a permanent note for the theme exists (or one already did),
      the theme stops appearing — covered themes are for linking, not
      re-creating.

## 11. Resurfacing + rituals

- [ ] **On this day.** With dated entries from a past year sharing today's
      month-day, open today's daily note → an *On this day* section at the
      panel foot lists them; click opens.
- [ ] **Still true?** One old (30+ days), barely-linked, non-dated note is
      offered at the panel foot. It's the SAME note all day (reload and
      check), a different one tomorrow. × dismisses for the session.
- [ ] **Close the day** (command) → one modal: today's entry, this date in
      past years, Inbox count → Triage, the most-wanted topic → Create,
      the still-true note → Revisit. Empty day → "Nothing open".
- [ ] **Weekly synthesis questions** (command, needs a model) → with 2+
      dated entries in the last 7 days, a note `Weekly synthesis YYYY-Wnn`
      is created in the Inbox: links to the entries + 3–5 QUESTIONS in your
      vocabulary naming specific claims — no summaries, no prose in your
      voice. Undo removes it.

## 12. Journal vs daily note (mode-aware Margin)

- [ ] **Detection.** Settings → Journaling shows Journal folders (default
      "Journal"); dated names and the Daily Notes plugin folder are
      automatic. A note in a listed folder with an undated name
      ("Morning pages 3") gets the same treatment as a dated note.
- [ ] **Log mode is quiet.** In a daily note, type task/bullet lines
      ("- [ ] email Sam") → no ghost link suggestions on those lines, no
      promote hint, no tension checks. The same bullets in a permanent
      note still get ghosts — there, lists are the thinking.
- [ ] **Reflection gets the apparatus.** In the same daily note, write a
      reflective paragraph (2–3 sentences) → the Margin leads with
      "↳ promote this thought to a note" and (if past entries share the
      date) "On this day", then related notes with permanent notes first.
- [ ] Click the promote hint → same behavior as the Promote command:
      Inbox note + provenance + link after the passage.
- [ ] **Every surface has a switch.** Toggling off Promote hint /
      On this day / Still true? / Wanted topics removes exactly that
      surface and nothing else.

## 13. Today's-entry invitation

- [ ] With no note dated today, the panel foot shows **Today →
      "↳ begin today's entry"**. Click → with the Daily Notes plugin
      enabled, its own command runs (your format, folder, template);
      without it, an ISO-named note is created in the first journal
      folder. Either way the entry opens and the row disappears.
- [ ] With today's entry already existing, the row never appears.
- [ ] Settings → Journaling → "Invite today's entry" off → row gone.
- [ ] Known limit: detection reads ISO (2026-08-12) and written
      ("August 12, 2026") names — an exotic daily-note format won't be
      recognized; turn the toggle off in that case.

## 14. Entry marking (kind tag + type/date properties) + tag suggestions

- [ ] **Daily vs journal.** In a dated note, write only task/bullet lines,
      wait ~3s → frontmatter gains `#daily`, `type: daily`, and
      `date: <today>`. Replace the content with two narrative paragraphs,
      wait → tag and type flip to journal; date stays.
- [ ] Add your own tag to the note → never touched. Hand-set `type: review`
      or your own `date` → Ariadne leaves both alone thereafter.
- [ ] An undated note in a journal folder gets its creation date as `date`.
- [ ] **The structure pays off:** in the Line, `type:journal` finds the
      narrative entries; a Bases view can sort/filter on the `date`
      property.
- [ ] A permanent note whose neighbors are journal entries is never
      offered `#journal` as a tag suggestion — kind is lifecycle, not topic.
- [ ] **Settings.** Marking off → nothing written. Rename the kind names
      (e.g. log/reflect) → new marks use them.
- [ ] **Tag suggestions.** Open a note whose semantic neighbors share a
      tag it lacks → a quiet `tags  #x #y` row appears in the Margin.
      Click a tag → it lands in frontmatter and leaves the row. × hides
      the row for this note this session. Suggestions only ever come from
      existing tags — never invented, never dated entry tags.

## 15. Entry kind drives the suggestion machinery

- [ ] **Themes ignore logs.** With several log-shaped dated entries about
      the same project (meeting notes) and no narrative entries, *Find
      recurring journal themes* reports not enough narrative entries —
      recurring meetings are not a recurring theme.
- [ ] **Synthesis ignores logs.** A week of task-list entries plus two
      narrative ones → the weekly synthesis links and questions only the
      narrative two. A week of only logs → "nothing narrative to
      synthesize."
- [ ] **Tension respects kind.** A long meeting-notes bullet block in a
      dated note triggers no tension/echo analysis; the same block in a
      permanent note stays eligible. A reflective paragraph in the dated
      note gets the full apparatus.

## 16. The zone grammar

- [ ] The panel reads as zones, top to bottom: input → results (when
      searching) → **now** → **today** → **vault** → glyph, each opened by
      a hairline + lowercase small-caps label. Empty zones show nothing —
      no rule, no label.
- [ ] **Legend fades.** The key legend appears only while the input is
      focused, fades out on blur.
- [ ] **No tautology.** With nothing related, the Now zone is simply
      absent — no "Write, and related notes appear here."
- [ ] **Daily reading.** The Still true? note in the Vault zone shows its
      opening line in quotes, italic — after the first repaint of the day.
- [ ] **Today zone.** Before the entry exists: "↳ begin today's entry".
      After: today's entry as a row. Past the configured hour (Settings →
      Journaling → Close-the-day hour): "↳ close the day". On Sunday:
      "↳ weekly synthesis".
- [ ] **Vault zone.** Wanted topics ("wanted by N"), the daily reading
      ("still true?"), and "Inbox → triage · N" when the Inbox is
      non-empty — clicking runs triage.
- [ ] **Now-zone verbs.** A long unstructured permanent note (2500+ chars,
      <2 headings) → "↳ split this note". A near-duplicate (cosine ≥.95)
      in view → "↳ merge with "X"" instead. Journal notes keep promote.

## 17. Perf pass + zone completions

- [ ] **One embedding per pause.** With debug logging on, a typing pause
      produces ONE worker embed for the paragraph (Margin, tension, and
      ghost share it) instead of three.
- [ ] **Themes teaser.** After the index settles (first idle with vectors),
      the Vault zone gains "↳ recurring themes · N" if uncaptured clusters
      exist — computed once per session, no model calls. Click runs the
      full themes flow with naming.
- [ ] **Promoted tally.** Promote a thought from today's entry → the Today
      row reads "<entry> · 1 promoted" (session-scoped).
- [ ] **⇧↵ capture.** Type a thought in the Line → the create row reads
      "＋ Create note "…" · ⇧ capture to Inbox". ⇧↵ (or ⇧-click) captures
      instantly to the Inbox with no model call; plain ↵ scaffolds as
      before. On touch, the row carries a Capture button.

## 18. The departure lounge (publish review)

Needs the Obsidian Publish core plugin enabled.

- [ ] **Affordance.** With Publish enabled and unscreened changes, the
      Vault zone shows "↳ review for publish · N changed". With Publish
      disabled or the setting off, it never appears.
- [ ] **Screening.** Run it. A personal/emotional note is HELD with a
      reason; a clean idea note is CLEARED and its frontmatter gains
      `publish: true`; held notes gain `publish: false`. A cleared note
      with links to journal entries or TODOs lands in "needs polish".
- [ ] **The bedroom has no door.** Journal entries and private-folder
      notes never appear in the modal at all — the summary says so.
- [ ] **Loud override.** A held note's "Override…" arms to "Yes, publish
      this" (destructive style) and only a second click within 5s
      releases it. It's remembered as overridden.
- [ ] **Fail-safe.** With no API key: flagged notes are held on local
      signals; unflagged ones say "awaiting your review" and clear only
      by your click. Nothing auto-clears.
- [ ] **Cost.** Re-running without edits screens nothing (ledger hash
      match). Editing one note → next run screens exactly one.
- [ ] **The actuator.** Open Obsidian's Publish dialog and upload the
      cleared notes — Ariadne never uploads anything itself.
- [ ] **Auto-marking.** New journal entries automatically carry
      `publish: false` in frontmatter (defense in depth).

## 19. Screening v2 (ensemble + precedents)

- [ ] **Full text.** A note that is impersonal for its first pages and
      personal only in its final paragraph is HELD (no truncation window
      to slip).
- [ ] **Journal register.** A candidate note written in your journal's
      voice but without flag keywords is flagged "reads like your journal
      entries (semantic)"; with no model configured and high affinity, it
      holds outright.
- [ ] **Precedents.** Override a hold (or hand-clear a note); screen a
      similar new note → debug the prompt (Debug logging) and see "The
      writer's own decisions on the most similar notes". Your decisions
      steer future verdicts; the model's own past verdicts never do.
- [ ] **Bootstrap.** A note with hand-set `publish: true/false` from
      before Ariadne is honored without a model call and becomes a
      precedent.
- [ ] **Manifest.** Cleared notes are listed as rows — one-click "Hold"
      overrules the model in the safe direction (and becomes a precedent).

## 20. Real-vault periodic fixes (0.6.1)

- [ ] **Actuator verified.** With the Daily Notes plugin misconfigured
      (non-daily folder/format), "begin today's entry" detects that no
      dated note appeared, says so, and creates a real entry itself.
- [ ] **Convention respected.** The fallback names today's entry in the
      journal folder's own dominant format (ISO / ISO+weekday / written /
      day-first), defaulting to ISO.
- [ ] **Hybrid weeklies count.** `2025-W18-May01`-style names are detected
      as periodic (demoted, journal-kind, never publish candidates via
      folder settings).
- [ ] **Loud misconfiguration.** A journalFolders/privateFolders entry
      matching no real folder logs a warning always, and Notices when
      publish review is live.
