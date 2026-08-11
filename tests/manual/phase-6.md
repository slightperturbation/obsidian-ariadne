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
      gemma3:27b pulled; or LM Studio). Set **Settings → Models → Local model
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
