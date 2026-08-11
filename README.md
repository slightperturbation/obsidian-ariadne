# Ariadne

An Obsidian plugin: one always-present line to search and connect your notes, and a margin that suggests links and structure as you write. Local-first semantic + lexical search, approval-first AI refactoring. Built in the spirit of Ahrens (*How to Take Smart Notes*) and Tufte.

See the design docs in the vault: `Projects/Ariadne/` (PRD, landscape research, implementation plan).

## Status

**Return mechanisms — wanted topics + recurring themes.** Two answers to the
real failure mode of a personal vault: capture without return. **Wanted** — a
quiet section at the panel foot ranking dangling `[[topics]]` by how many
distinct notes reach for them; one click scaffolds the note (a single dangling
reference is a typo, two is demand). **Recurring journal themes** — the
generalization of the echo card: dated entries that cluster in embedding space
with *no permanent note nearby* are a thought you keep having but never kept.
A command surfaces each theme, named in your own vocabulary (cheap model call —
local box when awake), with one keystroke to scaffold the note seeded from
your own journal's words. Covered themes (a permanent note already sits close)
are deliberately silent — that's a linking job, not a creation job.

Earlier: **Phase 4c (backlog) — Inbox triage + untitled notes.** *Triage Inbox*
proposes exactly one disposition per Inbox note, the Ahrens way — **elaborate**
(a live idea worth developing; the button just opens it, because elaborating is
writing), **merge** (a stored-vector near-duplicate; runs the normal previewed
merge flow), or **archive** (inert; an undoable move to `Archive/`). Local
signals decide for free where they can — emptiness, near-duplication — and the
model is asked only about the ambiguous middle, with the parser biased to
*elaborate* because archiving a live idea is the costly mistake. *Resolve
untitled notes* proposes real titles for `Untitled*` notes with content — the
note's own first heading or line when usable (free), a model title only
otherwise — and renames via Obsidian's link-rewriting rename, undoable, one
click each. Also: markdown **tables are now atomic** in the chunker — an
oversized table used to be hard-split mid-row into meaningless fragments.

Earlier: **Phase 6c — retirement + release track.** A guided **Retire replaced
plugins** command: it lists Smart Connections and Omnisearch with what Ariadne
covers instead, disables each only on an explicit per-item click (the ordinary
plugin toggle — reversible in settings), and offers to move `.smart-env/` to
the *system* trash. And the release plumbing for a BRAT beta: since BRAT ships
only `manifest.json`/`main.js`/`styles.css`, the worker bundle and ONNX
runtime (~24 MB) are attached to each GitHub release and **self-healed** by
the plugin on first semantic start if missing. A tag-triggered workflow builds
and drafts the release; `eslint-plugin-obsidianmd` is wired into `npm run
lint` and clean (its checks also raised `minAppVersion` to 1.7.2, matching the
APIs actually called). See *Installing (beta, via BRAT)* and *Releasing* below.

Earlier: **Phase 6b — local Gemma + smart routing.** An OpenAI-compatible provider for
a Gemma-class model on the home network (Ollama/LM Studio/llama.cpp), used
**opportunistically and never depended on**: a cached reachability probe with a
short timeout decides the route synchronously, quick tasks (connective
phrasing, tension checks) go local when the box is awake, quality-sensitive
work (scaffolds, splits, MoCs) stays on Claude, and a mid-call local failure
falls back to the cloud transparently. Local calls are free and run even past
the session cost cap — that's the point of having the box. The glyph says
which brain answered (`brain local` / `brain $0.03`), per the PRD's
honesty-as-UI rule. The panel also now restores itself after a plugin reload —
the Line is an always-present surface and staying silently closed was a bug.

Earlier: **Phase 6a — tension, echo, serendipity.** The Margin now notices two things
beyond relatedness: **echo** — you're re-writing a note that already exists
(near-verbatim cosine; free, instant, no API) — and **tension** — the
paragraph you're drafting contradicts an existing note. Tension detection
exploits the fact that embeddings measure *topic*, not *agreement*: high-cosine
neighbors in the ambiguous band are sent (cached, per-session capped, silenced
at the cost limit) to the reasoning model, which answers contradicts /
restates / neither with a terse explanation — "disagrees on whether spaced
repetition helps transfer", in italics on the card. "Neither" stays silent.
Echoes of already-linked notes are dropped (the connection is made); tensions
with linked notes still surface (contradicting a note you cite is exactly the
moment to be told). Cards are dismissible per note-pair per session, and act
like any row — open, ⌥ link, ⇧ weave. Plus **serendipity dials**: per-surface
(Margin / search Related layer) prominence bias that shapes how boldly results
present, never which results exist. Manual script:
[tests/manual/phase-6.md](tests/manual/phase-6.md).

Earlier: **Phase 5 — iOS parity, synced index, Bases.** A vault has one **index owner**
(runs the embedding model, writes the index shards) and any number of
**readers** that consume those shards over Sync. Desktops own and phones read
by default; either can be pinned per device in settings. That one decision
removes most of what made mobile hazardous — no 23 MB ONNX runtime read into
memory on the main thread, no ~30 MB model download over cellular, no
full-index snapshot crossing the worker boundary every few seconds, and no two
devices writing the same files for Sync to resolve by discarding one.

What a reader keeps is the point: lexical search is fully local, and **semantic
relatedness still works with no model at all**, because the note you're reading
was already embedded by the owner — the Margin queries with those stored
vectors instead of embedding new text. Only free-text semantic search genuinely
needs a local model, and the glyph says which mode you're in, including how
many notes have been edited since the owner last indexed them. Touch gets what
modifier keys used to gate: rows carry **Link** and **Weave** buttons, ghost
text accepts on tap (the iOS keyboard has no Tab), and the key legend is hidden
where those keys don't exist. Also a **Bases view** — *Related (Ariadne)* —
which re-orders a base's results by relatedness to the note you have open.
Manual script: [tests/manual/phase-5.md](tests/manual/phase-5.md).

Earlier: **pre-Phase-5 review pass.** A full code/behavior/UI review of everything
through 4b, then the fixes it found. The substantive ones: the vector search
now runs **in a Web Worker** (which already hosted the embedder), so a 30k-vector
query never blocks typing — and the store itself went from per-vector objects to
one contiguous `Float32Array` with slot reuse (154ms → 12.4ms at 30k). Cosine is
carried **raw** rather than remapped to `[0,1]`, which had silently pinned every
threshold at 0.5 and made the reticence slider inert; the Related layer was
mostly noise as a result. Persistence writes **deltas** for dirty shards only,
with a manifest written last and bounds-checked decoding, so an interrupted save
can't produce a torn index. Merge now preserves the duplicate's frontmatter,
rewrites inbound links, and never duplicates identical blocks. Retrieval applies
`in:`/`type:`/`since:` filters **during** candidate generation (a scoped query
could previously come back empty just because its hits weren't globally top-k),
indexes frontmatter aliases and tags, and gates the Margin behind a semantic
floor plus link-graph proximity — a note two hops from what you're writing now
scores above one that merely reads alike.

**Phase 4a — refactoring engine.** Structural refactors on top of the Phase 3
action framework: **semantic split** — a two-pass flow: an *unstructured* note
is first restructured in place into editable `##` sections (the model clusters
its paragraphs; content-preserving — it assigns text, never rewrites it), or
refused if it's already one atomic idea; running Split again on a *structured*
note extracts each section into a linked atomic child note and turns the
original into a Map-of-Content stub. All one atomic, undoable op. Then
**Map-of-Content generation** (a themed, annotated
index over a note's related neighborhood — pure creation, no preview), and
**near-duplicate merge** (union a close duplicate into the current note and
trash it, previewed). Commands: *Split this note*, *Generate Map of Content*,
*Merge near-duplicate*. Manual test script:
[tests/manual/phase-4.md](tests/manual/phase-4.md).

**Phase 4b — filing subsystem.** Batch, previewed, undoable filing actions:
an **attachments sweep** (move root-dumped images/PDFs/media into the
attachments folder via Obsidian's `fileManager`, which rewrites embeds;
collision-safe) and **empty-note cleanup** (trash frontmatter/whitespace-only
notes). Both share the one *Undo last action* command (the executor's undo now
takes non-text ops too). Manual script:
[tests/manual/phase-4b.md](tests/manual/phase-4b.md). **Deferred to 4c:** Inbox
triage and `Untitled`-with-content renaming.

Earlier: **Phase 3 — safe actions + Claude routing.** The first phase that writes to
the vault, and edits to existing notes go through one path: **propose → preview (diff) →
accept → atomic undo**, with a conflict check that refuses if a file changed
since the preview. Creating a new note (non-destructive, trivially reversible)
skips the modal — it's created and opened directly, still one-key undoable.
Actions: **new-note scaffolding** (type-aware, Johnny-Decimal home,
structure-and-key-ideas only — never prose in your voice; auto-disambiguates
name collisions) and **bidirectional link weaving** (⇧↵ in the Line / ⇧-click
in the Margin, previewed, with model-generated connective phrasing). A Claude provider (`claude-haiku-4-5` default — cheapest;
switch to a larger model in settings for higher-quality scaffolds) runs
reasoning tasks off the typing path, with a visible session cost in the glyph
and a hard per-session spend cap. Multi-file undo reverts a whole action in
one step. Manual test script:
[tests/manual/phase-3.md](tests/manual/phase-3.md).

Earlier: **Phase 2 — the Margin.** While you write, a right-sidebar panel
surfaces up to five related notes (typing-pause driven, confidence-scaled
prominence, click to open / ⌥-click to insert a link), and a CodeMirror
ghost-text extension offers faint inline `[[link]]` suggestions — Tab
accepts, Esc dismisses (with per-paragraph dismissal memory), gated behind a
raw-cosine reticence threshold tunable in settings. Suggestions never fire
mid-word, inside a wikilink, during IME composition, or for notes already
linked. Manual test script: [tests/manual/phase-2.md](tests/manual/phase-2.md).

Earlier: **Phase 1 — indexing core + the Line.** On top of the Phase 0
foundations, the plugin now indexes the vault incrementally (lexical BM25 +
vector fusion, chunked per heading/paragraph) and surfaces results through the
Line: a persistent search view with layered results (Found / Related),
per-note sparklines (linked · recent · atomic), a status glyph, and a
keyboard-first flow (↵ open, ⌘↵ new pane, ⌥↵ insert `[[link]]`).
Nothing writes to the vault.

Semantic search runs on a real local model — `bge-small-en-v1.5` via
transformers.js (~30 MB, downloaded from the HuggingFace hub on first run,
cached after; the deterministic hash embedder is the offline fallback). The
model loads in the background: lexical search is live immediately, and notes
gain vectors as the backfill completes.

**Both the model and the vector store live in a Web Worker** (`index-worker.js`),
so neither the embedding nor the cosine scan can stall typing — and because
they share a host, indexing a note and answering a query each take a single
round trip, with vectors never crossing the thread boundary.

The index persists to `.obsidian/plugins/ariadne/index/` as chunked files
(JSON chunks + int8-quantized binary vectors, each part under Obsidian Sync's
5 MB cap), so restarts warm-start from the snapshot and only re-index notes
whose mtime changed. A corrupt or version-bumped snapshot is silently
discarded and rebuilt — the vault is always the source of truth.

Manual test script: [tests/manual/phase-1.md](tests/manual/phase-1.md).

## Installing (beta, via BRAT)

Not yet in the community-plugin directory. To install the beta:

1. Install **BRAT** (Beta Reviewers Auto-update Tester) from Community plugins.
2. BRAT settings → *Add beta plugin* → this repository's GitHub slug.
3. Enable **Ariadne** in Community plugins.

BRAT downloads `manifest.json`, `main.js`, and `styles.css`; on first run with
semantic search enabled, Ariadne fetches its remaining runtime files (the
worker bundle and ONNX runtime, ~24 MB) from the same release and drops them
next to `main.js` — see `src/assets.ts`. If that download is blocked, search
falls back to lexical and the console says which file is missing.

## Releasing

1. Set `RELEASE_REPO` in `src/assets.ts` to the real GitHub slug (once).
2. Bump `manifest.json`/`versions.json` (`npm version …` runs `version-bump.mjs`).
3. Commit, tag with the bare version (`0.6.0`, no `v` — BRAT and `assetUrl()`
   both expect tag = manifest version), push the tag.
4. The `Release` workflow builds and attaches all six files as a **draft**
   release; review and publish it.

Community-plugin submission (later): `eslint-plugin-obsidianmd` is wired into
`npm run lint` and clean; the remaining checklist lives in the Obsidian docs.

## Development

Requires Node 20+.

```bash
npm install        # install dev dependencies (obsidian types, esbuild, vitest, eslint)
npm run dev        # watch-build main.js
npm run build      # typecheck + production bundle
npm test           # run unit tests (Vitest)
npm run lint       # eslint
```

### Loading into a vault

Develop against a **copy** of your vault (Obsidian Sync off), never the live one.

1. Build once: `npm run build` (or `npm run dev` to watch).
2. Symlink or copy this folder's `main.js`, `manifest.json`, and `styles.css` into
   `<dev-vault>/.obsidian/plugins/ariadne/`.
3. In Obsidian: Settings → Community plugins → enable **Ariadne**.
4. Optional: install the **Hot Reload** plugin (`pjeby/hot-reload`) — the `.hotreload`
   marker in this folder is already present — so builds reload automatically.

`app.emulateMobile(true)` in the developer console gives a first-pass mobile check;
real-device iOS testing comes before the Phase 5 sign-off.

## Layout

```
src/
  main.ts            # plugin entry: wiring, commands, vault-event → scheduler
  platform.ts        # Platform gating + requestIdleCallback shim
  settings/          # settings schema + tab UI
  core/              # status store, shared types
  index/             # crawler, chunker, lexical (BM25), embeddings, vectors,
                     # fusion (RRF), confidence, spark, scheduler, manager
  search/            # query grammar (type:, in:, since:)
  line/              # the unified Ariadne panel: view, result rows, sparkline
  margin/            # draft watcher + CM6 ghost-text extension
  model/             # Claude provider, router, task prompts/schemas
  actions/           # the write path: framework, split, moc, merge, filing
  ui/                # preview modals, diff rendering
  util/              # logger
tests/               # Vitest + hand-written obsidian mock; manual/ scripts
```

All phases through 4b are implemented; see Status above.

## License

MIT (placeholder — confirm before any public release).
