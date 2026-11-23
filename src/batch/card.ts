import type { FileChange } from "../actions/framework";
import { compactDiff, diffLines } from "../ui/diff";
import type { JobSpec } from "../chat/engine";
import { kindOf, tally, type BatchRecord, type BatchStep } from "./record";

/** A model a job can be run on, and where. */
export interface ModelChoice {
  /** "<server url>|<model>", or "cloud|<model>". */
  route: string;
  /** As shown: "gemma4:31b — this Mac". */
  label: string;
  cloud: boolean;
}

/** What the chat pane needs to run a batch job from its card. */
export interface BatchUi {
  create(spec: JobSpec, route?: string): Promise<BatchRecord>;
  run(id: string, opts?: { pauseAfter?: number }): Promise<BatchRecord>;
  stop(id: string): void;
  /** End a paused or stopped job for good, keeping what it did. */
  end(id: string): Promise<BatchRecord>;
  /** The models that can be picked now: each reachable local server's, and Claude's when a key is set. */
  choices(): Promise<ModelChoice[]>;
  /** The route picked when the card opens: the chat's own model. */
  defaultRoute(): string;
  /** Of these notes, those that may not be sent to a cloud model (local-only, journal, sealed), each with why. */
  notForCloud(paths: string[]): Array<{ path: string; why: string }>;
  /** What a job has spent on a cloud model so far, in USD. */
  spent(id: string): number;
  undo(id: string, path?: string): Promise<{ undone: number; problems: string[]; record: BatchRecord }>;
  /** Be told of every change to a job's record; returns a way to stop being told. */
  watch(id: string, cb: (record: BatchRecord) => void): () => void;
  /** The model each note goes to, for the card. */
  model(): string;
  openNote(path: string): void;
}

/** The notes the owner checks before letting a job run on. */
const SAMPLE = 3;
/** A rough time per note for the estimate on the card, in seconds. */
const PER_NOTE_S = 15;

const name = (p: string): string => p.split("/").pop()?.replace(/\.md$/, "") ?? p;

/** What a note's changes did, in a few words: "moved to Archive/2024; edited". */
export function describeChanges(path: string, changes: FileChange[]): string {
  const parts: string[] = [];
  for (const c of changes) {
    if (c.type === "move" && c.path === path) parts.push(`moved to ${c.to}`);
    else if (c.type === "move") parts.push(`${name(c.path)} moved to ${c.to}`);
    else if (c.type === "create") parts.push(`created ${c.path}`);
    else if (c.type === "delete") parts.push(c.path === path ? "sent to the trash" : `${name(c.path)} sent to the trash`);
    else parts.push(c.path === path ? "edited" : `${name(c.path)} edited`);
  }
  return [...new Set(parts)].join("; ");
}

const ICON: Record<BatchStep["status"], string> = { applied: "✓", left: "–", held: "⚠", failed: "✗", undone: "↺", pending: "…" };

export function renderJobCard(parent: HTMLElement, spec: JobSpec, ui: BatchUi): void {
  const card = parent.createDiv({ cls: "ariadne-chat-proposal ariadne-batch" });
  card.createDiv({ cls: "ariadne-chat-proposal-title", text: `Batch job: ${spec.selection}` });
  for (const line of spec.leftOut) card.createDiv({ cls: "ariadne-chat-proposal-why", text: `Left out — ${line}.` });

  const setup = card.createDiv();
  setup.createDiv({ cls: "ariadne-batch-label", text: "What to do with each note (you can change it):" });
  const instruction = setup.createEl("textarea", { cls: "ariadne-batch-instruction" });
  instruction.value = spec.instruction;
  instruction.rows = Math.min(6, Math.max(2, Math.ceil(spec.instruction.length / 70)));

  const list = setup.createEl("details", { cls: "ariadne-batch-notes" });
  list.createEl("summary", { text: `The ${spec.paths.length} note${spec.paths.length === 1 ? "" : "s"}` });
  for (const p of spec.paths.slice(0, 200)) {
    const a = list.createDiv().createEl("a", { text: p, attr: { href: "#" } });
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      ui.openNote(p);
    });
  }
  if (spec.paths.length > 200) list.createDiv({ text: `…and ${spec.paths.length - 200} more` });

  const minutes = Math.max(1, Math.round((spec.paths.length * PER_NOTE_S) / 60));
  const modelRow = setup.createDiv({ cls: "ariadne-batch-option" });
  modelRow.createSpan({ text: "Model: " });
  const picker = modelRow.createEl("select", { cls: "dropdown ariadne-batch-model" });
  const fallback = ui.defaultRoute();
  picker.createEl("option", { text: ui.model() || "the chat's model", value: fallback });
  picker.disabled = true;
  const about = setup.createDiv({ cls: "ariadne-chat-proposal-why" });
  let blocked: Array<{ path: string; why: string }> = [];
  const describe = () => {
    const cloud = picker.value.startsWith("cloud|");
    blocked = cloud ? ui.notForCloud(spec.paths) : [];
    const going = spec.paths.length - blocked.length;
    about.setText(
      cloud
        ? `Each note goes to Anthropic's ${picker.selectedOptions[0]?.text.split(" — ")[0] ?? "Claude"} on its own, over the internet, and is paid for per note (what it has cost is shown as it goes; it stops at your session cost limit). Only shareable notes are sent: ${blocked.length ? `${blocked.length} of the ${spec.paths.length} — local-only or journal — are left out, and the job's agents are not shown any such note either` : "every note here is shareable, and the job's agents are not shown any note that is not"}. Changes are made as it goes; one Undo puts everything back.`
        : `Each note goes to ${picker.selectedOptions[0]?.text ?? "the local model"} on its own, one at a time — about ${minutes} min. Changes are made as it goes; when it is done you see what was done to each note, and one Undo puts everything back.`,
    );
    sample.disabled = going === 0;
    if (all) all.disabled = going === 0;
  };
  picker.addEventListener("change", describe);
  const shrinkRow = setup.createEl("label", { cls: "ariadne-batch-option" });
  const shrink = shrinkRow.createEl("input", { attr: { type: "checkbox" } });
  shrink.checked = spec.allowShrink;
  shrinkRow.appendText(" Allow a note to be cut by more than a third (otherwise such a change is held, not made)");

  const row = setup.createDiv({ cls: "ariadne-chat-proposal-buttons" });
  const sample = row.createEl("button", { cls: "mod-cta", text: spec.paths.length > SAMPLE ? `Try ${SAMPLE} first` : "Run" });
  const all = spec.paths.length > SAMPLE ? row.createEl("button", { text: "Run all" }) : null;
  const cancel = row.createEl("button", { text: "Cancel" });
  const status = card.createDiv({ cls: "ariadne-chat-proposal-status" });
  cancel.addEventListener("click", () => {
    setup.remove();
    status.setText("Not started — nothing was changed.");
  });
  describe();
  void ui
    .choices()
    .then((choices) => {
      if (choices.length === 0) return;
      picker.empty();
      let picked = false;
      for (const c of choices) {
        const o = picker.createEl("option", { text: c.label, value: c.route });
        if (c.route === fallback) {
          o.selected = true;
          picked = true;
        }
      }
      // The chat's own model is not among those reachable now: it is offered anyway, as it was chosen.
      if (!picked && fallback) picker.prepend(Object.assign(document.createElement("option"), { text: `${ui.model() || fallback} (not answering now)`, value: fallback, selected: true }));
    })
    .catch(() => {})
    .finally(() => {
      picker.disabled = false;
      describe();
    });

  const start = (pauseAfter?: number) => {
    const text = instruction.value.trim();
    if (text.length < 8) {
      status.setText("Give the instruction first.");
      return;
    }
    const route = picker.value;
    const out = new Set(blocked.map((b) => b.path));
    const paths = spec.paths.filter((p) => !out.has(p));
    if (paths.length === 0) {
      status.setText("None of these notes may be sent to a cloud model — pick a local one.");
      return;
    }
    const leftOut = [...spec.leftOut, ...(out.size ? [`${out.size} note${out.size === 1 ? "" : "s"} not sent to a cloud model (local-only or journal)`] : [])];
    setup.remove();
    for (const line of leftOut.slice(spec.leftOut.length)) card.createDiv({ cls: "ariadne-chat-proposal-why", text: `Left out — ${line}.` });
    void ui
      .create({ ...spec, paths, leftOut, instruction: text, allowShrink: shrink.checked }, route)
      .then((record) => follow(card, record, ui, pauseAfter))
      .catch((err: unknown) => status.setText(`Not started: ${err instanceof Error ? err.message : "error"}.`));
  };
  sample.addEventListener("click", () => start(spec.paths.length - blocked.length > SAMPLE ? SAMPLE : undefined));
  all?.addEventListener("click", () => start());
}

/** The running job, and what it did: kept up to date from its record. */
function follow(card: HTMLElement, first: BatchRecord, ui: BatchUi, pauseAfter?: number): void {
  const id = first.job.id;
  const head = card.createDiv({ cls: "ariadne-batch-progress" });
  const controls = card.createDiv({ cls: "ariadne-chat-proposal-buttons" });
  const steps = card.createDiv({ cls: "ariadne-batch-steps" });
  const report = card.createDiv({ cls: "ariadne-batch-report" });
  const shown = new Map<string, HTMLElement>();

  const renderStep = (record: BatchRecord, s: BatchStep) => {
    let line = shown.get(s.path);
    if (!line) {
      line = steps.createDiv({ cls: "ariadne-batch-step" });
      shown.set(s.path, line);
    }
    line.empty();
    line.createSpan({ cls: `ariadne-batch-icon ariadne-batch-${s.status}`, text: `${ICON[s.status]} ` });
    const a = line.createEl("a", { text: s.path, attr: { href: "#" } });
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      ui.openNote(s.path);
    });
    const what = s.status === "applied" || s.status === "undone" ? describeChanges(s.path, s.changes) : "";
    const detail = [what, s.summary, s.why].filter(Boolean).join(" — ");
    if (detail) line.createSpan({ cls: "ariadne-batch-detail", text: ` ${detail}` });
    for (const f of s.findings) line.createDiv({ cls: "ariadne-batch-finding", text: `↳ ${f}` });
    // Text a model changed is shown exactly — so a change it was not asked for is seen, not missed.
    const edits = s.changes.filter((c) => c.type === "modify");
    if (edits.length && (s.status === "applied" || s.status === "held" || s.status === "undone")) {
      const box = line.createEl("details", { cls: "ariadne-batch-diff" });
      box.createEl("summary", { text: s.status === "held" ? "show what it would have changed" : "show the change" });
      for (const c of edits) {
        if (edits.length > 1 || c.path !== s.path) box.createDiv({ cls: "ariadne-diff-head", text: c.path });
        const pre = box.createEl("pre", { cls: "ariadne-diff-body" });
        for (const op of compactDiff(diffLines(c.before ?? "", c.after ?? ""), 1)) {
          if (op.type === "skip") pre.createDiv({ cls: "ariadne-diff-skip", text: `⋯ ${op.count} unchanged lines` });
          else pre.createDiv({ cls: `ariadne-diff-${op.type}`, text: (op.type === "add" ? "+ " : op.type === "del" ? "− " : "  ") + op.text });
        }
      }
    }
    if (s.status === "applied" && record.status !== "running") {
      const undo = line.createEl("a", { cls: "ariadne-batch-undo", text: " undo", attr: { href: "#" } });
      undo.addEventListener("click", (ev) => {
        ev.preventDefault();
        undo.remove();
        void ui
          .undo(id, s.path)
          .then((r) => {
            if (r.problems.length) report.createDiv({ text: `Not undone: ${r.problems.join("; ")}` });
          })
          .catch((err: unknown) => {
            report.createDiv({ text: `Not undone: ${err instanceof Error ? err.message : "error"}.` });
            renderStep(record, s);
          });
      });
    }
  };

  const render = (record: BatchRecord) => {
    const done = record.steps.length;
    const total = record.job.paths.length;
    for (const s of record.steps) renderStep(record, s);
    controls.empty();
    report.empty();
    if (record.status === "running") {
      head.setText(`Working: ${done} of ${total} done${done < total ? ` — next: ${record.job.paths.find((p) => !shown.has(p)) ?? ""}` : ""}`);
      controls.createEl("button", { text: "Stop" }).addEventListener("click", () => ui.stop(id));
      return;
    }
    const counts = tally(record);
    const words = Object.entries(counts).map(([k, n]) => `${n} ${k === "left" ? "left as they were" : k === "held" ? "held (not changed)" : k}`);
    const applied = record.steps.some((s) => s.status === "applied" || s.status === "pending");
    const undoneSome = record.steps.some((s) => s.status === "undone");
    head.setText(
      record.status === "paused"
        ? `Tried ${done} of ${total}: ${words.join(", ")}. Look at what was done below, then go on or stop here.`
        : record.status === "undone"
          ? `Undone: every change this job made has been put back.`
          : record.status === "ended"
            ? `Stopped by you after ${done} of ${total} — ${words.join(", ") || "nothing changed"}. The rest were not looked at.`
            : `${record.status === "stopped" ? `Stopped after ${done} of ${total}` : `Done: ${total} note${total === 1 ? "" : "s"}`} — ${words.join(", ") || "nothing changed"}.`,
    );
    if (record.why) report.createDiv({ cls: "ariadne-batch-label", text: `Stopped because ${record.why}.` });
    const cost = ui.spent(id);
    if (cost > 0) report.createDiv({ cls: "ariadne-chat-proposal-why", text: `Spent on Claude so far: $${cost.toFixed(2)}${done ? ` (about $${(cost / done).toFixed(3)} a note)` : ""}.` });
    const waiting = record.steps.filter((s) => (s.status === "applied" || s.status === "pending") && s.why?.startsWith("not undone yet"));
    if (waiting.length) {
      report.createDiv({
        cls: "ariadne-batch-label",
        text: `Not undone yet — open in the editor: ${waiting.map((s) => name(s.path)).join(", ")}. Close ${waiting.length === 1 ? "it" : "them"}, then click "Undo the rest".`,
      });
    }
    if (record.status === "paused" || record.status === "stopped") {
      const go = controls.createEl("button", { cls: "mod-cta", text: record.status === "paused" ? "Continue" : "Resume" });
      go.addEventListener("click", () => {
        // Once: a second click must not start the same job twice.
        go.disabled = true;
        for (const s of record.steps) if (s.status === "failed") {
          shown.get(s.path)?.remove();
          shown.delete(s.path);
        }
        void ui.run(id).catch((err: unknown) => report.setText(`Could not go on: ${err instanceof Error ? err.message : "error"}.`));
      });
    }
    const failedCount = record.steps.filter((s) => s.status === "failed").length;
    if (record.status === "done" && failedCount > 0) {
      const again = controls.createEl("button", { text: `Try the ${failedCount} that failed again` });
      again.addEventListener("click", () => {
        again.disabled = true;
        for (const s of record.steps) if (s.status === "failed") shown.get(s.path)?.remove();
        for (const s of record.steps) if (s.status === "failed") shown.delete(s.path);
        void ui.run(id).catch((err: unknown) => report.setText(`Could not go on: ${err instanceof Error ? err.message : "error"}.`));
      });
    }
    if (record.status === "paused" || record.status === "stopped") {
      // Stop for good, keeping what was done (there is an undo for that beside it).
      const end = controls.createEl("button", { text: applied ? "Stop here, keep these" : "Stop here" });
      end.addEventListener("click", () => {
        for (const b of Array.from(controls.querySelectorAll("button"))) (b as HTMLButtonElement).disabled = true;
        void ui.end(id).catch((err: unknown) => {
          report.setText(`Could not stop it: ${err instanceof Error ? err.message : "error"}.`);
          for (const b of Array.from(controls.querySelectorAll("button"))) (b as HTMLButtonElement).disabled = false;
        });
      });
    }
    if (applied) {
      const label = undoneSome ? "Undo the rest" : record.status === "paused" || record.status === "stopped" ? "Undo these and stop" : "Undo all";
      const undo = controls.createEl("button", { text: label });
      undo.addEventListener("click", () => {
        // Nothing else from this card while it undoes.
        for (const b of Array.from(controls.querySelectorAll("button"))) (b as HTMLButtonElement).disabled = true;
        const stopAfter = record.status === "paused" || record.status === "stopped";
        void ui
          .undo(id)
          .then(async (r) => {
            // "Undo these and stop": once put back, the job is not run on.
            if (stopAfter && r.record.status !== "undone") await ui.end(id).catch(() => {});
            const changed = r.problems.filter((p) => !p.endsWith(": open in the editor"));
            if (changed.length) report.createDiv({ text: `Not undone, because the note changed since the job: ${changed.join("; ")}` });
          })
          .catch((err: unknown) => {
            report.setText(`Could not undo: ${err instanceof Error ? err.message : "error"}.`);
            // Nothing was done: the card's buttons work again.
            for (const b of Array.from(controls.querySelectorAll("button"))) (b as HTMLButtonElement).disabled = false;
          });
      });
    }
    const findings = record.steps.filter((s) => s.findings.length);
    if (findings.length) {
      report.createDiv({ cls: "ariadne-batch-label", text: `Found (${findings.length} note${findings.length === 1 ? "" : "s"}):` });
      const table = report.createEl("table", { cls: "ariadne-batch-findings" });
      for (const s of findings) {
        const tr = table.createEl("tr");
        tr.createEl("td", { text: name(s.path) });
        tr.createEl("td", { text: s.findings.join(" · ") });
      }
    }
    if (record.status === "done" && record.steps.some((s) => s.status === "applied")) {
      report.createDiv({ cls: "ariadne-chat-proposal-why", text: `Kinds of change: ${[...new Set(record.steps.filter((s) => s.status === "applied").map((s) => kindOf(s.changes)))].join(", ")}. The command "Undo a batch job" can put this back later, too.` });
    }
  };

  render(first);
  const stopWatching = ui.watch(id, render);
  void ui
    .run(id, pauseAfter !== undefined ? { pauseAfter } : {})
    .catch((err: unknown) => {
      head.setText(`Stopped: ${err instanceof Error ? err.message : "error"}.`);
      stopWatching();
    });
}
