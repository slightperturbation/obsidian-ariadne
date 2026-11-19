import { ItemView, MarkdownRenderer, type WorkspaceLeaf } from "obsidian";
import { ConflictError, type ActionProposal, type ExecutedAction } from "../actions/framework";
import { compactDiff, diffLines } from "../ui/diff";
import type { ChatEngine, ChatMessage } from "./engine";

export const CHAT_VIEW_TYPE = "ariadne-chat";

export interface ChatViewDeps {
  /** The engine, or null when no local model is set up. */
  engine: () => ChatEngine | null;
  /** Who is answering, for the header: "gemma4:31b · this Mac", or why nobody is. */
  model: () => { label: string; ready: boolean };
  /** Apply a proposal the owner accepted; the result can undo it. */
  apply: (proposal: ActionProposal) => Promise<ExecutedAction>;
  openNote: (path: string) => void;
  /** Whether journal entries may be shown to the local model in this chat. */
  journal: { possible: () => boolean; on: () => boolean; set: (on: boolean) => void };
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
    this.inputEl = form.createEl("textarea", { cls: "ariadne-chat-input", attr: { rows: "2", placeholder: "Ask about your notes, or ask for a correction…" } });
    this.sendEl = form.createEl("button", { cls: "mod-cta", text: "Send" });
    this.sendEl.addEventListener("click", () => void this.send());
    this.inputEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        void this.send();
      }
    });
    this.renderHead();
    this.renderIntro();
  }

  async onClose(): Promise<void> {
    this.contentEl.replaceChildren();
  }

  private renderHead(): void {
    const head = this.headEl;
    head.replaceChildren();
    const model = this.deps.model();
    head.createSpan({ cls: "ariadne-chat-model", text: model.label });
    head.createSpan({ cls: "ariadne-chat-local", text: "local only", attr: { title: "Answered by a model on your own machines. Nothing in this chat is sent to a cloud model." } });
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
    const fresh = head.createEl("button", { cls: "ariadne-chat-new", text: "New chat" });
    fresh.addEventListener("click", () => {
      if (this.busy) return;
      this.messages = [];
      this.deps.engine()?.reset();
      this.listEl.replaceChildren();
      this.renderIntro();
    });
  }

  private renderIntro(): void {
    const intro = this.listEl.createDiv({ cls: "ariadne-chat-intro" });
    intro.createEl("p", { text: "Ask about your notes and records. Every answer names the notes it rests on." });
    intro.createEl("p", { text: "To correct something, say what is wrong. A correction is shown as a before and after; nothing is written until you press Apply, and each applied change can be undone." });
    const tries = intro.createDiv({ cls: "ariadne-chat-tries" });
    for (const q of ["Check my records for problems.", "What is on my next trip, day by day?", "Which records disagree with the note they came from?"]) {
      const b = tries.createEl("button", { text: q });
      b.addEventListener("click", () => {
        this.inputEl.value = q;
        this.inputEl.focus();
      });
    }
    if (!this.deps.model().ready) intro.createEl("p", { cls: "ariadne-chat-warn", text: "No local model is reachable. Set a local endpoint and model in Ariadne's settings (for example http://localhost:11434/v1), and start it." });
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
      src.createSpan({ text: "Rests on: " });
      reply.sources.forEach((path, i) => {
        if (i > 0) src.appendText(" · ");
        const a = src.createEl("a", { text: path.split("/").pop()?.replace(/\.md$/, "") ?? path, attr: { title: path, href: "#" } });
        a.addEventListener("click", (ev) => {
          ev.preventDefault();
          this.deps.openNote(path);
        });
      });
    } else if (!reply.failed) {
      el.createDiv({ cls: "ariadne-chat-sources ariadne-chat-unsourced", text: "Rests on no note — treat it as unverified." });
    }
    for (const proposal of reply.proposals ?? []) this.renderProposal(el, proposal);
    this.scrollDown();
  }

  private renderProposal(parent: HTMLElement, proposal: ActionProposal): void {
    const card = parent.createDiv({ cls: "ariadne-chat-proposal" });
    card.createDiv({ cls: "ariadne-chat-proposal-title", text: `Proposed: ${proposal.title}` });
    if (proposal.description) card.createDiv({ cls: "ariadne-chat-proposal-why", text: proposal.description });
    for (const change of proposal.changes) {
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
              .then(() => status.setText("Undone — the note is as it was."))
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
