import { ItemView, MarkdownRenderer, type WorkspaceLeaf } from "obsidian";
import { ConflictError, type ActionProposal, type ExecutedAction } from "../actions/framework";
import { compactDiff, diffLines } from "../ui/diff";
import type { ChatEngine, ChatMessage } from "./engine";
import { choiceKey, type ModelGroup } from "./models";
import { renderJobCard, type BatchUi } from "../batch/card";

export const CHAT_VIEW_TYPE = "ariadne-chat";

export interface ChatViewDeps {
  /** The engine, or null when no local model is set up. */
  engine: () => ChatEngine | null;
  /** Who answers when nothing is picked: "gemma4:31b · this Mac", or why nobody can — as last asked. */
  model: () => { label: string; ready: boolean };
  /** Ask the local endpoints afresh whether they are there. Until this has run, "not reachable" is only "not asked yet". */
  probe: () => Promise<void>;
  /** The local models there are to pick from, and the pick. */
  models: {
    list: () => Promise<ModelGroup[]>;
    /** "endpoint|model", or "" for the default. */
    chosen: () => string;
    choose: (value: string) => void;
  };
  /** Apply a proposal the owner accepted; the result can undo it. */
  apply: (proposal: ActionProposal) => Promise<ExecutedAction>;
  openNote: (path: string) => void;
  /**
   * Hand the plugin this pane's way of asking the owner whether something may be sent off the
   * machine. The tools call it before every lookup outside the vault.
   */
  webAsker: (ask: ((what: string) => Promise<boolean>) | null) => void;
  /** Keep the conversation as a note; returns where it was put. */
  save: (messages: ChatMessage[]) => Promise<string>;
  /** Whether journal entries may be shown to the local model in this chat. */
  journal: { possible: () => boolean; on: () => boolean; set: (on: boolean) => void };
  /** Running batch jobs from their cards. Absent: a job card says it cannot run here. */
  batch?: BatchUi;
}

/**
 * The vault chat pane: a conversation with a local model about the notes.
 * The transcript lives in this pane only — it is not written to the vault
 * or anywhere else, and is gone when the pane closes.
 */
export class ChatView extends ItemView {
  private messages: ChatMessage[] = [];
  private busy = false;
  private listEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendEl!: HTMLButtonElement;
  private headEl!: HTMLElement;
  /** What the endpoints said they have, when last asked. */
  private groups: ModelGroup[] | null = null;
  /** The endpoints have been asked since this pane opened: only then is "nobody is there" a finding. */
  private asked = false;
  /** The owner said, in this conversation, that lookups outside need not ask each time. */
  private webAlways = false;

  constructor(
    leaf: WorkspaceLeaf,
    private deps: ChatViewDeps,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Vault chat";
  }

  getIcon(): string {
    return "message-square";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.replaceChildren();
    root.classList.add("ariadne", "ariadne-chat");
    this.headEl = root.createDiv({ cls: "ariadne-chat-head" });
    this.listEl = root.createDiv({ cls: "ariadne-chat-list" });
    const form = root.createDiv({ cls: "ariadne-chat-form" });
    this.inputEl = form.createEl("textarea", { cls: "ariadne-chat-input", attr: { rows: "4", placeholder: "Ask about your notes, or ask for a correction…" } });
    const row = form.createDiv({ cls: "ariadne-chat-form-row" });
    row.createSpan({ cls: "ariadne-chat-hint", text: "Enter sends · Shift+Enter starts a new line" });
    this.sendEl = row.createEl("button", { cls: "mod-cta", text: "Send" });
    this.sendEl.addEventListener("click", () => void this.send());
    // The box grows with what is written in it, up to a good part of the pane; beyond that it scrolls.
    this.inputEl.addEventListener("input", () => this.fitInput());
    this.inputEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        void this.send();
      }
    });
    this.renderHead();
    this.renderIntro();
    void this.refreshModels();
    this.deps.webAsker((what) => this.askWeb(what));
  }

  /**
   * Before anything leaves the machine: the exact words, shown to the owner,
   * who sends them or does not. Never while journal entries are being read
   * in this chat — what was read there must have no way out.
   */
  private askWeb(what: string): Promise<boolean> {
    if (this.deps.journal.on()) {
      this.note(`Not sent: “${what}”. Lookups outside the vault are off while “journal” is ticked.`);
      return Promise.resolve(false);
    }
    if (this.webAlways) {
      this.note(`Sent outside: ${what}`);
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const card = this.listEl.createDiv({ cls: "ariadne-chat-proposal ariadne-chat-web" });
      card.createDiv({ cls: "ariadne-chat-proposal-title", text: "Send this outside your vault?" });
      card.createDiv({ cls: "ariadne-chat-web-what", text: what });
      card.createDiv({ cls: "ariadne-chat-proposal-why", text: "It goes to Wikivoyage or Wikipedia, as written. Nothing else is sent." });
      const row = card.createDiv({ cls: "ariadne-chat-proposal-buttons" });
      const done = (ok: boolean, said: string) => {
        row.remove();
        card.createDiv({ cls: "ariadne-chat-proposal-status", text: said });
        resolve(ok);
      };
      row.createEl("button", { cls: "mod-cta", text: "Send" }).addEventListener("click", () => done(true, "Sent."));
      row.createEl("button", { text: "Send, and don't ask again in this chat" }).addEventListener("click", () => {
        this.webAlways = true;
        done(true, "Sent. Further lookups in this chat will be shown here, not asked.");
      });
      row.createEl("button", { text: "Don't send" }).addEventListener("click", () => done(false, "Not sent."));
      this.scrollDown();
    });
  }

  /** Ask each local endpoint what it has installed, and show it in the picker. */
  private async refreshModels(): Promise<void> {
    try {
      const [groups] = await Promise.all([this.deps.models.list(), this.deps.probe().catch(() => {})]);
      this.groups = groups;
    } catch {
      this.groups = [];
    }
    this.asked = true;
    this.renderHead();
    this.renderWarning();
  }

  /** Can anybody answer? The model that was picked if one was, otherwise the default. */
  private reachable(): boolean {
    const chosen = this.deps.models.chosen();
    if (!chosen) return this.deps.model().ready;
    return (this.groups ?? []).some((g) => g.reachable && g.models.some((m) => choiceKey(g.url, m) === chosen));
  }

  /** Said only once the endpoints have been asked, and taken back as soon as one answers. */
  private renderWarning(): void {
    this.listEl.querySelector(".ariadne-chat-warn")?.remove();
    if (!this.asked || this.reachable()) return;
    const intro = this.listEl.querySelector(".ariadne-chat-intro");
    if (!intro) return;
    const chosen = this.deps.models.chosen();
    intro.createEl("p", {
      cls: "ariadne-chat-warn",
      text: chosen
        ? `${chosen.split("|").pop() ?? "The model you picked"} is not available right now. Pick another model above, or start it and press ↻.`
        : "No local model answered. Start your local model server (for example Ollama), or set a local endpoint and model in Ariadne's settings, then press ↻.",
    });
  }

  /** The picker: every model installed on each local endpoint, and the default. */
  private renderPicker(head: HTMLElement): void {
    const chosen = this.deps.models.chosen();
    const fallback = this.deps.model();
    const select = head.createEl("select", { cls: "ariadne-chat-pick dropdown", attr: { "aria-label": "Local model that answers", title: "The local model that answers in this chat" } });
    select.createEl("option", { value: "", text: `Default · ${this.asked || fallback.ready ? fallback.label : "looking for local models…"}` });
    let found = chosen === "";
    for (const group of this.groups ?? []) {
      const og = select.createEl("optgroup", { attr: { label: group.reachable ? group.label : `${group.label} — not reachable` } });
      for (const model of group.models) {
        const value = choiceKey(group.url, model);
        og.createEl("option", { value, text: model });
        if (value === chosen) found = true;
      }
    }
    // A pick that is not there now (its machine is off, the model was removed) is still shown, as what it is.
    if (!found) select.createEl("option", { value: chosen, text: `${chosen.split("|").pop() ?? chosen} — not available now` });
    select.value = chosen;
    select.addEventListener("change", () => {
      if (this.busy) {
        select.value = this.deps.models.chosen();
        return;
      }
      this.deps.models.choose(select.value);
      this.renderWarning();
      const label = select.selectedOptions[0]?.text ?? "the default";
      this.note(`Answers now come from ${select.value ? `${label} (${this.groups?.find((g) => select.value.startsWith(`${g.url}|`))?.label ?? "local"})` : label.replace(/^Default · /, "the default, ")}.`);
    });
    const again = head.createEl("button", { cls: "ariadne-chat-refresh clickable-icon", text: "↻", attr: { "aria-label": "Look again for installed models", title: "Look again for installed models" } });
    again.addEventListener("click", () => void this.refreshModels());
  }

  async onClose(): Promise<void> {
    this.deps.webAsker(null);
    this.contentEl.replaceChildren();
  }

  private renderHead(): void {
    const head = this.headEl;
    head.replaceChildren();
    this.renderPicker(head);
    head.createSpan({ cls: "ariadne-chat-local", text: "local model", attr: { title: "Answered by a model on your own machines; nothing is sent to a cloud model. A lookup on the web (Wikivoyage, Wikipedia) is shown to you first, and sent only if you say so." } });
    if (this.deps.journal.possible()) {
      const label = head.createEl("label", { cls: "ariadne-chat-journal", attr: { title: "Let the local model read journal entries in this chat. Off: they are never shown to it." } });
      const box = label.createEl("input", { type: "checkbox" });
      box.checked = this.deps.journal.on();
      box.addEventListener("change", () => {
        this.deps.journal.set(box.checked);
        this.note(box.checked ? "Journal entries may now be read in this chat." : "Journal entries are no longer read in this chat.");
      });
      label.appendText(" journal");
    }
    const keep = head.createEl("button", { cls: "ariadne-chat-save", text: "Save", attr: { title: "Keep this conversation as a note. Until you do, it exists only in this pane." } });
    keep.addEventListener("click", () => {
      if (this.busy) return;
      if (this.messages.length === 0) {
        this.note("There is nothing to save yet.");
        return;
      }
      void this.deps
        .save(this.messages)
        .then((path) => {
          const line = this.listEl.createDiv({ cls: "ariadne-chat-note" });
          line.appendText("Saved as ");
          const a = line.createEl("a", { text: path, attr: { href: "#" } });
          a.addEventListener("click", (ev) => {
            ev.preventDefault();
            this.deps.openNote(path);
          });
          line.appendText(". It can be undone with “Undo last action”.");
          this.scrollDown();
        })
        .catch((err: unknown) => this.note(`Not saved: ${err instanceof Error ? err.message : "error"}.`));
    });
    const fresh = head.createEl("button", { cls: "ariadne-chat-new", text: "New chat" });
    fresh.addEventListener("click", () => {
      if (this.busy) return;
      this.messages = [];
      this.webAlways = false;
      this.deps.engine()?.reset();
      this.listEl.replaceChildren();
      this.renderIntro();
    });
  }

  private renderIntro(): void {
    const intro = this.listEl.createDiv({ cls: "ariadne-chat-intro" });
    intro.createEl("p", { text: "Ask about your notes. Every answer lists the notes it is based on." });
    intro.createEl("p", { text: "To correct something, say what is wrong. A correction is shown as a before and after; nothing is written until you press Apply, and each applied change can be undone." });
    const tries = intro.createDiv({ cls: "ariadne-chat-tries" });
    for (const q of ["Which notes did I change this week?", "What is on my next trip, day by day?", "Which of my notes mention a deadline?"]) {
      const b = tries.createEl("button", { text: q });
      b.addEventListener("click", () => {
        this.inputEl.value = q;
        this.fitInput();
        this.inputEl.focus();
      });
    }
    this.renderWarning();
  }

  /** Make the input as tall as its text, between its resting height and about two fifths of the pane. */
  private fitInput(): void {
    const el = this.inputEl;
    el.setCssStyles({ height: "auto" });
    const max = Math.max(160, Math.round(this.contentEl.clientHeight * 0.4));
    const wanted = el.scrollHeight + 2;
    el.setCssStyles({ height: `${Math.min(wanted, max)}px`, overflowY: wanted > max ? "auto" : "hidden" });
  }

  /** A line from the pane itself, not from the model. */
  private note(text: string): void {
    this.listEl.createDiv({ cls: "ariadne-chat-note", text });
    this.scrollDown();
  }

  private scrollDown(): void {
    this.listEl.scrollTop = this.listEl.scrollHeight;
  }

  private async send(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text || this.busy) return;
    const engine = this.deps.engine();
    if (!engine) {
      this.note("No local model is set up, so there is nobody to answer. Nothing was sent anywhere.");
      return;
    }
    this.busy = true;
    this.sendEl.disabled = true;
    this.inputEl.value = "";
    this.fitInput();
    this.listEl.querySelector(".ariadne-chat-intro")?.remove();
    this.listEl.createDiv({ cls: "ariadne-chat-msg ariadne-chat-user", text });
    const working = this.listEl.createDiv({ cls: "ariadne-chat-working", text: "Thinking…" });
    this.scrollDown();
    let reply: ChatMessage;
    try {
      reply = await engine.send(this.messages, text, (step) => {
        working.textContent = `Looking: ${step}`;
        this.scrollDown();
      });
    } catch (err) {
      reply = { role: "assistant", text: `That failed (${err instanceof Error ? err.message.slice(0, 120) : "error"}). Nothing was changed.`, failed: true };
    }
    working.remove();
    this.messages.push({ role: "user", text }, reply);
    await this.renderReply(reply);
    this.busy = false;
    this.sendEl.disabled = false;
    this.renderHead();
    this.inputEl.focus();
  }

  private async renderReply(reply: ChatMessage): Promise<void> {
    const el = this.listEl.createDiv({ cls: `ariadne-chat-msg ariadne-chat-reply${reply.failed ? " ariadne-chat-failed" : ""}` });
    if (reply.steps?.length) {
      const steps = el.createEl("details", { cls: "ariadne-chat-steps" });
      steps.createEl("summary", { text: `Looked at ${reply.steps.length} thing${reply.steps.length === 1 ? "" : "s"}` });
      for (const s of reply.steps) steps.createDiv({ text: s });
    }
    const body = el.createDiv({ cls: "ariadne-chat-body" });
    // The model's words are rendered as Markdown for reading; they can link, but they cannot act.
    await MarkdownRenderer.render(this.app, reply.text, body, "", this);
    if (reply.sources?.length) {
      const src = el.createDiv({ cls: "ariadne-chat-sources" });
      src.createSpan({ text: "Based on: " });
      reply.sources.forEach((path, i) => {
        if (i > 0) src.appendText(" · ");
        // A page on the web is marked as such, and opens in the browser; a note opens in the editor.
        if (/^https?:\/\//.test(path)) {
          src.createEl("a", { cls: "external-link", text: `🌐 ${decodeURIComponent(path.split("/").pop() ?? path).replace(/_/g, " ")}`, attr: { title: path, href: path, target: "_blank", rel: "noopener" } });
          return;
        }
        const a = src.createEl("a", { text: path.split("/").pop()?.replace(/\.md$/, "") ?? path, attr: { title: path, href: "#" } });
        a.addEventListener("click", (ev) => {
          ev.preventDefault();
          this.deps.openNote(path);
        });
      });
    } else if (!reply.failed) {
      el.createDiv({ cls: "ariadne-chat-sources ariadne-chat-unsourced", text: "Not based on any of your notes — check it before relying on it." });
    }
    for (const proposal of reply.proposals ?? []) this.renderProposal(el, proposal);
    for (const job of reply.jobs ?? []) {
      if (this.deps.batch) renderJobCard(el, job, this.deps.batch);
      else el.createDiv({ cls: "ariadne-chat-proposal", text: "A batch job was set up, but batch jobs cannot run here." });
    }
    this.scrollDown();
  }

  private renderProposal(parent: HTMLElement, proposal: ActionProposal): void {
    const card = parent.createDiv({ cls: "ariadne-chat-proposal" });
    card.createDiv({ cls: "ariadne-chat-proposal-title", text: `Proposed: ${proposal.title}` });
    if (proposal.description) card.createDiv({ cls: "ariadne-chat-proposal-why", text: proposal.description });
    const moves = proposal.changes.filter((c) => c.type === "move");
    if (moves.length > 0) {
      // A move changes no text: where each note is and where it would go is the whole of it.
      const list = card.createDiv({ cls: "ariadne-chat-moves" });
      for (const change of moves) {
        const row = list.createDiv({ cls: "ariadne-chat-move" });
        const link = row.createEl("a", { text: change.path, attr: { href: "#" } });
        link.addEventListener("click", (ev) => {
          ev.preventDefault();
          this.deps.openNote(change.path);
        });
        row.createSpan({ text: ` → ${change.to ?? ""}` });
      }
    }
    for (const change of proposal.changes) {
      if (change.type === "move") continue;
      const head = card.createDiv({ cls: "ariadne-diff-head" });
      const link = head.createEl("a", { text: change.path, attr: { href: "#" } });
      link.addEventListener("click", (ev) => {
        ev.preventDefault();
        this.deps.openNote(change.path);
      });
      const pre = card.createEl("pre", { cls: "ariadne-diff-body" });
      for (const op of compactDiff(diffLines(change.before ?? "", change.after ?? ""), 2)) {
        if (op.type === "skip") pre.createDiv({ cls: "ariadne-diff-skip", text: `⋯ ${op.count} unchanged lines` });
        else pre.createDiv({ cls: `ariadne-diff-${op.type}`, text: (op.type === "add" ? "+ " : op.type === "del" ? "− " : "  ") + op.text });
      }
    }
    const row = card.createDiv({ cls: "ariadne-chat-proposal-buttons" });
    const status = card.createDiv({ cls: "ariadne-chat-proposal-status" });
    const apply = row.createEl("button", { cls: "mod-cta", text: "Apply" });
    const skip = row.createEl("button", { text: "Skip" });
    skip.addEventListener("click", () => {
      row.remove();
      status.setText("Skipped — nothing was changed.");
    });
    apply.addEventListener("click", () => {
      apply.disabled = true;
      skip.disabled = true;
      void this.deps
        .apply(proposal)
        .then((done) => {
          row.replaceChildren();
          status.setText("Applied. ");
          const undo = status.createEl("a", { text: "Undo", attr: { href: "#" } });
          undo.addEventListener("click", (ev) => {
            ev.preventDefault();
            void done
              .undo()
              .then(() =>
                status.setText(
                  proposal.changes.every((c) => c.type === "create")
                    ? "Undone — the note was removed again."
                    : proposal.changes.every((c) => c.type === "move")
                      ? `Undone — ${proposal.changes.length === 1 ? "the note is" : "the notes are"} back where ${proposal.changes.length === 1 ? "it was" : "they were"}.`
                      : proposal.changes.length > 1
                        ? "Undone — the notes are as they were."
                        : "Undone — the note is as it was.",
                ),
              )
              .catch((err: unknown) => status.setText(`Could not undo: ${err instanceof Error ? err.message : "the note has changed since"}.`));
          });
        })
        .catch((err: unknown) => {
          row.remove();
          status.setText(
            err instanceof ConflictError
              ? `Not applied: ${err.message}. The note changed after this was proposed; ask again.`
              : `Not applied: ${err instanceof Error ? err.message : "error"}.`,
          );
        });
    });
  }
}
