# Phase 5 — manual test script (iOS parity, synced index, Bases)

Prereq: Phases 1–4b passing on desktop. This phase is about **two devices**, so
most of it can only be checked with the vault open on both.

⚠️ Confirm both devices are on the **test-vault copy**, not real Syncd.

The model: a vault has one **index owner** (runs the embedding model, writes
`.obsidian/plugins/ariadne/index/`) and any number of **readers** that consume
those files over Sync. Desktop owns, phone reads, by default.

## 1. Desktop still owns the index (regression)

- [ ] **Settings → Ariadne → Indexing → This device's role** reads *Automatic*.
- [ ] Glyph shows `N notes · idle · semantic on` — the desktop still loads the
      model and still writes shards.
- [ ] Edit a note, wait ~5 s, and confirm the files under
      `.obsidian/plugins/ariadne/index/` have new mtimes.
- [ ] Nothing in the panel changed for mouse use: ↑↓ / ↵ / ⌘↵ / ⌥↵ / ⇧↵ all
      behave as before, and the key legend is still shown.

## 2. Phone as a reader

Let Sync finish first — the phone needs the desktop's index files.

- [ ] Open the vault on the phone. Glyph shows `semantic synced` (not
      `semantic on`, not `semantic fallback`).
- [ ] **Nothing downloads.** Watch for a stall on first open: there should be no
      ~30 MB model fetch and no long pause. If you see `semantic loading…` on
      the phone, the role resolved wrong — check the setting.
- [ ] Search for a word you know is in a note → lexical results appear.
- [ ] Open a note and look at the Margin: **related cards appear**, with the
      same prominence tiers as desktop. This is the key claim of the phase —
      relatedness works with no model on the device, using the vectors the
      desktop computed.
- [ ] Confirm the phone never writes: note the mtimes of the files under
      `.obsidian/plugins/ariadne/index/`, use the phone for a few minutes
      (including editing notes), and confirm they are unchanged.

## 3. Staleness is reported, not hidden

- [ ] On the phone, edit a note substantially and wait for the index to settle.
- [ ] The glyph gains `· N awaiting desktop`.
- [ ] That note is still findable by **word** (lexical re-indexed locally)…
- [ ] …but it drops out of Margin relatedness until the desktop re-indexes it.
      This is intended: the phone has no way to embed the new text.
- [ ] Open the vault on the desktop, let it index and save, let Sync settle,
      reopen on the phone → the count clears and the note is related again.

## 4. Touch reachability

On the phone, with the Ariadne panel open:

- [ ] The modifier-key legend (`↑↓ move · ↵ open · …`) is **not** shown.
- [ ] **Tapping a row opens the note.** Tapping does not require a long press,
      and scrolling the list does not accidentally open anything.
- [ ] Each row has **Link** and **Weave** buttons. Tap **Link** → a `[[link]]`
      is inserted at the cursor in the open note. Tap **Weave** → the
      bidirectional weave runs, exactly as ⇧↵ does on desktop.
- [ ] Tap targets are comfortable (44 pt) — you don't have to aim.
- [ ] Ghost text: type until a faint suggestion appears (it's underlined with
      dots on mobile). **Tap it → it's accepted.** Then trigger another and
      **keep typing instead → it disappears.** Neither needs a key that the iOS
      keyboard doesn't have.

## 5. An owner-less vault degrades honestly

- [ ] On the phone only, with no synced index present (or temporarily rename
      the `index/` folder on desktop before syncing), open the vault.
- [ ] Glyph shows no `semantic synced`; search still works lexically; the
      Margin is empty rather than wrong.
- [ ] Console log says `no synced vectors found — lexical only`.

## 6. iPad as owner (optional)

Only if you want an iPad to index on its own.

- [ ] Set **This device's role → Owner (indexes)** on the iPad and reload.
- [ ] It downloads the model and begins indexing. Expect this to be slow and
      memory-hungry; that's why it isn't the default.
- [ ] Make sure the desktop is **not** also indexing the same vault at the same
      time, or the two will overwrite each other's shards through Sync.

## 7. Bases view

Needs Obsidian 1.10+ (Bases). On an older version the view simply isn't offered
and the console notes `Bases API not available`.

- [ ] Create a base with a query matching a decent number of notes.
- [ ] In the view selector, choose **Related (Ariadne)**.
- [ ] With a note open, the view shows **Related to \<that note\>** — the base's
      results re-ordered by relatedness, with sparklines and prominence tiers —
      followed by **Also in this base (N)** for the rest.
- [ ] Tapping/clicking a row opens that note.
- [ ] Switch the open note → the ordering updates to the new focus.
- [ ] With no note open, it says so rather than rendering an empty list.

## Known limits (not bugs)

- A reader can't answer free-text *semantic* search (something has to embed the
  query); its search bar is lexical. Relatedness is the semantic surface there.
- Vectors for a note edited on a reader are gone until the owner re-indexes it.
- Two owners on one vault will fight over the shard files via Sync.
