import { App, Modal } from "obsidian";

export interface ListPreviewOptions {
  title: string;
  description?: string;
  /** One line per operation (e.g. "shot.png → Supporting Files/"). */
  lines: string[];
  /** Style the confirm button as destructive (deletes). */
  destructive?: boolean;
  confirmLabel?: string;
}

/**
 * A lightweight accept gate for batch filing operations (moves, deletes) whose
 * "diff" is a list of files, not a text change. Same contract as PreviewModal:
 * nothing happens unless the user confirms; Esc/Cancel is a no-op.
 */
export class ListPreviewModal extends Modal {
  private accepted = false;

  constructor(
    app: App,
    private options: ListPreviewOptions,
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
    title.textContent = this.options.title;
    root.appendChild(title);

    if (this.options.description) {
      const desc = doc.createElement("div");
      desc.classList.add("ariadne-preview-desc");
      desc.textContent = this.options.description;
      root.appendChild(desc);
    }

    const list = doc.createElement("div");
    list.classList.add("ariadne-filing-list");
    for (const line of this.options.lines) {
      const row = doc.createElement("div");
      row.classList.add("ariadne-filing-row");
      row.textContent = line;
      list.appendChild(row);
    }
    root.appendChild(list);

    const buttons = doc.createElement("div");
    buttons.classList.add("ariadne-preview-buttons");
    const cancel = doc.createElement("button");
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.close());
    const confirm = doc.createElement("button");
    confirm.classList.add(this.options.destructive ? "mod-warning" : "mod-cta");
    confirm.textContent = this.options.confirmLabel ?? (this.options.destructive ? "Delete" : "Apply");
    confirm.addEventListener("click", () => this.accept());
    buttons.append(cancel, confirm);
    root.appendChild(buttons);

    this.scope.register([], "Enter", () => {
      this.accept();
      return false;
    });
    confirm.focus();
  }

  private accept(): void {
    if (this.accepted) return;
    this.accepted = true;
    this.close();
    this.onAccept();
  }

  onClose(): void {
    this.contentEl.replaceChildren();
  }
}
