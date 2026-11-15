#!/usr/bin/env node
/**
 * Embedding evaluation against a real vault — "does model X actually retrieve
 * better HERE?", answered with the vault's own structure instead of a public
 * leaderboard.
 *
 * Ground truth is the writer's wikilinks: a note and the notes it links to
 * are related by the writer's own judgment, so a good embedder should rank
 * link targets high among a note's semantic neighbors (link prediction).
 * A second task, known-item search, embeds each note's TITLE as a query and
 * asks whether the note itself comes back — the Line's "search by concept
 * name" in miniature.
 *
 * Models:
 *   snapshot            the vectors Ariadne already persisted (production)
 *   ollama:<model>      any embedding model served by a local Ollama
 *   tjs:<hf-repo>       any ONNX model via transformers.js (q8), as the
 *                       in-plugin worker would run it
 *   …+title             either kind, with the note title added to each
 *                       chunk's embedded text (document context)
 *   …+ctx               like +title, but dated/journal notes get no title
 *                       (a date names no topic) — Ariadne's production recipe
 *
 * --mask-links true removes the wikilink text itself from every chunk before
 * embedding (hard mode): a link's literal text names its target, so without
 * masking a model can "predict" a link by matching the title string.
 *
 * It also prints matched-quantile calibration knots (candidate cosine → the
 * snapshot model's cosine at the same rarity), which is what lets a new
 * model inherit every cosine threshold tuned against the old one.
 *
 * Usage:
 *   node scripts/eval-embeddings.mjs --vault ~/Vault \
 *     --models snapshot,ollama:embeddinggemma,ollama:embeddinggemma+title
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] ?? "true"]);
    return acc;
  }, []),
);
const VAULT = (args.vault ?? "").replace(/^~/, process.env.HOME);
const OLLAMA = args.ollama ?? "http://127.0.0.1:11434";
const MODELS = (args.models ?? "snapshot,ollama:embeddinggemma").split(",");
const OUT = args.out;
const MASK = args["mask-links"] === "true";
if (!VAULT) {
  console.error("usage: eval-embeddings.mjs --vault <path> [--models a,b] [--out file.json]");
  process.exit(1);
}
const INDEX = join(VAULT, ".obsidian/plugins/ariadne/index");

/* ── Load the snapshot: chunks + production vectors ───────────────────── */

const manifest = JSON.parse(readFileSync(join(INDEX, "manifest.json"), "utf8"));
const chunks = [];
for (let i = 0; i < manifest.parts; i++) {
  chunks.push(...JSON.parse(readFileSync(join(INDEX, `chunks-${i}.json`), "utf8")));
}
const notePaths = manifest.notes.map((n) => n.path);
const noteIndex = new Map(notePaths.map((p, i) => [p, i]));
const titleOf = (p) => basename(p).replace(/\.md$/i, "");
const chunkNote = Int32Array.from(chunks.map((c) => noteIndex.get(c.path) ?? -1));
const N = chunks.length;
/** Chunk text as embedded: optionally with wikilinks reduced to their alias (or removed). */
const textOf = (c) =>
  MASK
    ? c.text.replace(/!?\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_m, _t, alias) => alias ?? "")
    : c.text;

function snapshotVectors() {
  const byId = new Map();
  for (let i = 0; i < manifest.parts; i++) {
    const buf = readFileSync(join(INDEX, `vectors-${i}.bin`));
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (buf.byteLength < 8) continue;
    const count = view.getUint32(4, true);
    let off = 8;
    for (let r = 0; r < count; r++) {
      const idLen = view.getUint16(off, true);
      off += 2;
      const id = buf.subarray(off, off + idLen).toString("utf8");
      off += idLen;
      const scale = view.getFloat32(off, true);
      off += 4;
      const vec = new Float32Array(manifest.dim);
      for (let d = 0; d < manifest.dim; d++) vec[d] = view.getInt8(off + d) * scale;
      off += manifest.dim;
      byId.set(id, vec);
    }
  }
  return byId;
}

function normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const inv = s > 0 ? 1 / Math.sqrt(s) : 0;
  for (let i = 0; i < v.length; i++) v[i] *= inv;
  return v;
}

/* ── Prompting conventions per model family ───────────────────────────── */

function prompts(model) {
  const m = model.toLowerCase();
  if (m.includes("embeddinggemma")) {
    return {
      doc: (text, title) => `title: ${title ?? "none"} | text: ${text}`,
      query: (q) => `task: search result | query: ${q}`,
    };
  }
  if (m.includes("qwen3-embedding")) {
    return {
      doc: (text) => text,
      query: (q) =>
        `Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery: ${q}`,
    };
  }
  if (m.includes("nomic")) {
    return { doc: (t) => `search_document: ${t}`, query: (q) => `search_query: ${q}` };
  }
  return { doc: (t) => t, query: (q) => q };
}

async function ollamaEmbed(model, inputs) {
  const out = [];
  const BATCH = 32;
  for (let i = 0; i < inputs.length; i += BATCH) {
    const resp = await fetch(`${OLLAMA}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: inputs.slice(i, i + BATCH), truncate: true }),
    });
    if (!resp.ok) throw new Error(`ollama embed ${model}: HTTP ${resp.status} ${await resp.text()}`);
    const body = await resp.json();
    for (const e of body.embeddings) out.push(normalize(Float32Array.from(e)));
    if ((i / BATCH) % 10 === 0) process.stderr.write(`\r  ${model}: ${Math.min(i + BATCH, inputs.length)}/${inputs.length}`);
  }
  process.stderr.write("\n");
  return out;
}

async function tjsEmbed(repo, inputs) {
  const { pipeline } = await import("@huggingface/transformers");
  const extractor = await pipeline("feature-extraction", repo, { dtype: "q8" });
  const out = [];
  const BATCH = 16;
  for (let i = 0; i < inputs.length; i += BATCH) {
    const batch = inputs.slice(i, i + BATCH);
    const res = await extractor(batch, { pooling: "mean", normalize: true });
    const d = res.dims[res.dims.length - 1];
    for (let b = 0; b < batch.length; b++) out.push(Float32Array.from(res.data.subarray(b * d, (b + 1) * d)));
    if ((i / BATCH) % 20 === 0) process.stderr.write(`\r  ${repo}: ${Math.min(i + BATCH, inputs.length)}/${inputs.length}`);
  }
  process.stderr.write("\n");
  return out;
}

function tjsPrompts(repo) {
  const r = repo.toLowerCase();
  if (r.includes("bge")) {
    return {
      doc: (t, title) => (title ? `${title}\n\n${t}` : t),
      query: (q) => `Represent this sentence for searching relevant passages: ${q}`,
    };
  }
  if (r.includes("embeddinggemma")) return prompts("embeddinggemma");
  if (r.includes("leaf-ir") || r.includes("arctic")) {
    return {
      doc: (t, title) => (title ? `${title}\n\n${t}` : t),
      query: (q) => `Represent this sentence for searching relevant passages: ${q}`,
    };
  }
  return { doc: (t, title) => (title ? `${title}\n\n${t}` : t), query: (q) => q };
}

/* ── Ground truth: resolved wikilinks ─────────────────────────────────── */

function allMarkdown(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) allMarkdown(p, acc);
    else if (name.endsWith(".md")) acc.push(p.slice(VAULT.length + 1));
  }
  return acc;
}
const vaultFiles = allMarkdown(VAULT);
const byBase = new Map();
for (const p of vaultFiles) {
  const k = titleOf(p).toLowerCase();
  if (!byBase.has(k)) byBase.set(k, p);
}
const noteMeta = notePaths.map((p) => {
  let text = "";
  try {
    text = readFileSync(join(VAULT, p), "utf8");
  } catch {
    /* deleted since the snapshot */
  }
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const type = /^type:\s*"?([^"\n]+)"?\s*$/m.exec(fm)?.[1]?.trim();
  const ai = /^authorship:\s*"?ai-generated"?\s*$/m.test(fm);
  const journal = /^(Personal\/Journal|Periodic)\//.test(p) || /^\d{4}-\d{2}-\d{2}/.test(titleOf(p));
  const quiet = ai || type === "correspondence-moment" || type === "project-artifact";
  const targets = new Set();
  for (const m of text.matchAll(/\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
    const raw = m[1].trim();
    const resolved = raw.includes("/")
      ? vaultFiles.find((f) => f === `${raw}.md` || f === raw)
      : byBase.get(raw.toLowerCase());
    const t = resolved !== undefined ? noteIndex.get(resolved) : undefined;
    if (t !== undefined && t !== noteIndex.get(p)) targets.add(t);
  }
  return { path: p, journal, quiet, targets: [...targets] };
});

/* ── Similarity + metrics ─────────────────────────────────────────────── */

function simMatrix(vecs) {
  const d = vecs[0].length;
  const flat = new Float32Array(N * d);
  vecs.forEach((v, i) => flat.set(v, i * d));
  const S = new Float32Array(N * N);
  for (let i = 0; i < N; i++) {
    const io = i * d;
    for (let j = i; j < N; j++) {
      const jo = j * d;
      let s = 0;
      for (let k = 0; k < d; k++) s += flat[io + k] * flat[jo + k];
      S[i * N + j] = s;
      S[j * N + i] = s;
    }
  }
  return S;
}

const chunksOfNote = notePaths.map(() => []);
chunkNote.forEach((n, i) => n >= 0 && chunksOfNote[n].push(i));

/** Note→note score: best chunk pair (each chunk votes; a note keeps its best). */
function noteScores(S, src) {
  const best = new Float32Array(notePaths.length).fill(-2);
  for (const a of chunksOfNote[src]) {
    const row = a * N;
    for (let b = 0; b < N; b++) {
      const n = chunkNote[b];
      if (n < 0 || n === src) continue;
      const s = S[row + b];
      if (s > best[n]) best[n] = s;
    }
  }
  return best;
}

function rankOf(scores, target, eligible) {
  const t = scores[target];
  let rank = 1;
  for (let i = 0; i < scores.length; i++) if (eligible(i) && i !== target && scores[i] > t) rank++;
  return rank;
}

function linkPrediction(S, slice) {
  const eligible = slice === "thinking" ? (i) => !noteMeta[i].quiet : () => true;
  let n = 0;
  let r5 = 0;
  let r10 = 0;
  let mrrFirst = 0;
  let mrrAll = 0;
  let pairs = 0;
  for (let s = 0; s < noteMeta.length; s++) {
    const meta = noteMeta[s];
    if (slice === "thinking" && (meta.quiet || meta.journal)) continue;
    const targets = meta.targets.filter((t) => eligible(t) && chunksOfNote[t].length > 0);
    if (targets.length === 0 || chunksOfNote[s].length === 0) continue;
    const scores = noteScores(S, s);
    const ranks = targets.map((t) => rankOf(scores, t, eligible));
    n++;
    r5 += ranks.filter((r) => r <= 5).length / targets.length;
    r10 += ranks.filter((r) => r <= 10).length / targets.length;
    mrrFirst += 1 / Math.min(...ranks);
    for (const r of ranks) {
      mrrAll += 1 / r;
      pairs++;
    }
  }
  return {
    sources: n,
    pairs,
    "recall@5": r5 / n,
    "recall@10": r10 / n,
    mrrFirst: mrrFirst / n,
    mrrPerLink: mrrAll / pairs,
  };
}

function knownItem(chunkVecs, queryVecs, queryNotes) {
  const d = chunkVecs[0].length;
  let mrr = 0;
  let r1 = 0;
  let r5 = 0;
  queryVecs.forEach((q, qi) => {
    const best = new Float32Array(notePaths.length).fill(-2);
    for (let b = 0; b < N; b++) {
      const n = chunkNote[b];
      if (n < 0) continue;
      const v = chunkVecs[b];
      let s = 0;
      for (let k = 0; k < d; k++) s += q[k] * v[k];
      if (s > best[n]) best[n] = s;
    }
    const rank = rankOf(best, queryNotes[qi], () => true);
    mrr += 1 / rank;
    if (rank === 1) r1++;
    if (rank <= 5) r5++;
  });
  const n = queryVecs.length;
  return { queries: n, mrr: mrr / n, "recall@1": r1 / n, "recall@5": r5 / n };
}

/** Tail quantiles of cross-note chunk-pair cosines — a model's "rarity scale". */
const QUANTILES = [0.5, 0.75, 0.9, 0.95, 0.975, 0.99, 0.995, 0.998, 0.999, 0.9995, 0.9998, 0.9999, 0.99995];
function crossNoteQuantiles(S) {
  const vals = [];
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      if (chunkNote[i] !== chunkNote[j]) vals.push(S[i * N + j]);
    }
  }
  const sorted = Float32Array.from(vals).sort();
  return QUANTILES.map((q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
}

/* ── Run ──────────────────────────────────────────────────────────────── */

const titledNotes = noteMeta
  .map((m, i) => ({ i, title: titleOf(m.path) }))
  .filter((x) => x.title.split(/\s+/).length >= 2 && chunksOfNote[x.i].length > 0 && !noteMeta[x.i].journal);

console.log(
  `vault: ${VAULT}${MASK ? "  [link text MASKED]" : ""}\nindexed notes: ${notePaths.length} · chunks: ${N} · notes with resolvable links: ${
    noteMeta.filter((m) => m.targets.length).length
  } · title queries: ${titledNotes.length}\n`,
);

const results = {};
let baseQuantiles;
for (const spec of MODELS) {
  const t0 = Date.now();
  let vecs;
  let queryVecs;
  try {
  if (spec.startsWith("tjs:")) {
    const mode = /\+(title|ctx)$/.exec(spec)?.[1];
    const repo = spec.slice(4).replace(/\+(title|ctx)$/, "");
    const p = tjsPrompts(repo);
    const ctxTitle = (c) => {
      if (!mode) return undefined;
      if (mode === "ctx" && noteMeta[noteIndex.get(c.path)]?.journal) return undefined;
      return titleOf(c.path);
    };
    vecs = await tjsEmbed(
      repo,
      chunks.map((c) => p.doc(textOf(c), ctxTitle(c))),
    );
    queryVecs = await tjsEmbed(
      repo,
      titledNotes.map((q) => p.query(q.title)),
    );
  } else if (spec === "snapshot") {
    if (MASK) {
      console.error("snapshot vectors were embedded unmasked — use tjs:<repo> with --mask-links");
      continue;
    }
    const byId = snapshotVectors();
    vecs = chunks.map((c) => normalize(byId.get(c.id) ?? new Float32Array(manifest.dim)));
    try {
      const { pipeline } = await import("@huggingface/transformers");
      const id = manifest.embedderId.replace(/^transformers:/, "");
      const extractor = await pipeline("feature-extraction", id, { dtype: "q8" });
      const prefix = /bge/i.test(id) ? "Represent this sentence for searching relevant passages: " : "";
      queryVecs = [];
      for (const q of titledNotes) {
        const out = await extractor([prefix + q.title], { pooling: "mean", normalize: true });
        queryVecs.push(Float32Array.from(out.data));
      }
    } catch (err) {
      console.error(`  (snapshot query embeddings unavailable: ${String(err).slice(0, 120)})`);
    }
  } else if (spec.startsWith("ollama:")) {
    const withTitle = spec.endsWith("+title");
    const model = spec.slice(7).replace(/\+title$/, "");
    const p = prompts(model);
    vecs = await ollamaEmbed(
      model,
      chunks.map((c) => p.doc(textOf(c), withTitle ? titleOf(c.path) : undefined)),
    );
    queryVecs = await ollamaEmbed(
      model,
      titledNotes.map((q) => p.query(q.title)),
    );
  } else {
    console.error(`unknown model spec: ${spec}`);
    continue;
  }
  } catch (err) {
    console.log(`── ${spec}: FAILED — ${String(err).slice(0, 200)}\n`);
    continue;
  }
  const embedMs = Date.now() - t0;
  const S = simMatrix(vecs);
  const quantiles = crossNoteQuantiles(S);
  baseQuantiles ??= quantiles;
  results[spec] = {
    dim: vecs[0].length,
    embedSeconds: +(embedMs / 1000).toFixed(1),
    linksAll: linkPrediction(S, "all"),
    linksThinking: linkPrediction(S, "thinking"),
    knownItem: queryVecs ? knownItem(vecs, queryVecs, titledNotes.map((q) => q.i)) : null,
    quantiles,
    calibrationToBase: quantiles.map((raw, i) => [+raw.toFixed(4), +baseQuantiles[i].toFixed(4)]),
  };
  const r = results[spec];
  const f = (x) => (x * 100).toFixed(1).padStart(5);
  console.log(`── ${spec} (dim ${r.dim}, embed ${r.embedSeconds}s)`);
  for (const [label, lp] of [["all notes     ", r.linksAll], ["thinking notes", r.linksThinking]]) {
    console.log(
      `  links · ${label}: R@5 ${f(lp["recall@5"])}  R@10 ${f(lp["recall@10"])}  MRR ${f(lp.mrrFirst)}  MRR/link ${f(lp.mrrPerLink)}   (${lp.sources} notes, ${lp.pairs} links)`,
    );
  }
  if (r.knownItem) {
    console.log(
      `  title→note known-item: R@1 ${f(r.knownItem["recall@1"])}  R@5 ${f(r.knownItem["recall@5"])}  MRR ${f(r.knownItem.mrr)}   (${r.knownItem.queries} queries)`,
    );
  }
  console.log(`  cross-note cosine quantiles: ${QUANTILES.map((q, i) => `${q}:${quantiles[i].toFixed(3)}`).join("  ")}\n`);
}
if (OUT) writeFileSync(OUT, JSON.stringify({ quantileGrid: QUANTILES, results }, null, 2));
