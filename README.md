# Ariadne

An Obsidian plugin: one always-present line to search and connect your notes, and a margin that suggests links and structure as you write. Local-first semantic + lexical search, approval-first AI refactoring. Built in the spirit of Ahrens (*How to Take Smart Notes*) and Tufte.

See the design docs in the vault: `Projects/Ariadne/` (PRD, landscape research, implementation plan).

## Status

**Pre-Phase-5 review pass.** A full code/behavior/UI review of everything
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
