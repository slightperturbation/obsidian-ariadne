import { App, Modal } from "obsidian";
import type { ActionProposal, FileChange } from "../actions/framework";
import { diffLines, compactDiff, type CompactOp } from "./diff";

/**
 * The accept gate. Shows every file the action would touch as a diff card;
 * nothing happens unless the user presses Accept (or ↵). Esc/Cancel closes
 * with no side effects — the caller only ever receives accept via callback.
 */
export class PreviewModal extends Modal {
  private accepted = false;

  constructor(
    app: App,
    private proposal: ActionProposal,
    private onAccept: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const root = this.contentEl;
    const doc = root.ownerDocument;
    root.classList.add("ariadne", "ariadne-preview");
    root.replaceChildren();

    const title = doc.createElement("div");
    title.classList.add("ariadne-preview-title");
    title.textContent = this.proposal.title;
    root.appendChild(title);

    if (this.proposal.description) {
      const desc = doc.createElement("div");
      desc.classList.add("ariadne-preview-desc");
      desc.textContent = this.proposal.description;
      root.appendChild(desc);
    }

    for (const change of this.proposal.changes) {
      root.appendChild(this.changeCard(doc, change));
    }

    const buttons = doc.createElement("div");
    buttons.classList.add("ariadne-preview-buttons");
    const cancel = doc.createElement("button");
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.close());
    const accept = doc.createElement("button");
    accept.classList.add("mod-cta");
    accept.textContent = "Accept";
    accept.addEventListener("click", () => this.accept());
    buttons.append(cancel, accept);
    root.appendChild(buttons);

    this.scope.register([], "Enter", () => {
      this.accept();
      return false;
    });
    accept.focus();
  }

  private accept(): void {
    if (this.accepted) return;
    this.accepted = true;
    this.close();
    this.onAccept();
  }

  private changeCard(doc: Document, change: FileChange): HTMLElement {
    const card = doc.createElement("div");
    card.classList.add("ariadne-diff-card");

    const head = doc.createElement("div");
    head.classList.add("ariadne-diff-head");
    const verb =
      change.type === "create" ? "create" : change.type === "modify" ? "edit" : "delete";
    head.textContent = `${verb} · ${change.path}`;
    card.appendChild(head);

    const ops: CompactOp[] = compactDiff(
      diffLines(change.before ?? "", change.after ?? ""),
      2,
    );
    const body = doc.createElement("pre");
    body.classList.add("ariadne-diff-body");
    for (const op of ops) {
      const line = doc.createElement("div");
      if (op.type === "skip") {
        line.classList.add("ariadne-diff-skip");
        line.textContent = `⋯ ${op.count} unchanged lines`;
      } else {
        line.classList.add(`ariadne-diff-${op.type}`);
        line.textContent =
          (op.type === "add" ? "+ " : op.type === "del" ? "− " : "  ") + op.text;
      }
      body.appendChild(line);
    }
    card.appendChild(body);
    return card;
  }

  onClose(): void {
    this.contentEl.replaceChildren();
  }
}
