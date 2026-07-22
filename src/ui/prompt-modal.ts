import { App, Modal } from "obsidian";

/** One-line text prompt (used by "New scaffolded note"). ↵ submits, Esc cancels. */
export class PromptModal extends Modal {
  private submitted = false;

  constructor(
    app: App,
    private options: { title: string; placeholder?: string; initial?: string },
    private onSubmit: (value: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const root = this.contentEl;
    const doc = root.ownerDocument;
    root.classList.add("ariadne");
    root.replaceChildren();

    const title = doc.createElement("div");
    title.classList.add("ariadne-preview-title");
    title.textContent = this.options.title;
    root.appendChild(title);

    const input = doc.createElement("textarea");
    input.classList.add("ariadne-prompt-input");
    input.rows = 3;
    input.placeholder = this.options.placeholder ?? "";
    input.value = this.options.initial ?? "";
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        this.submit(input.value);
      }
    });
    root.appendChild(input);
    input.focus();
    input.select();
  }

  private submit(value: string): void {
    if (this.submitted || !value.trim()) return;
    this.submitted = true;
    this.close();
    this.onSubmit(value.trim());
  }

  onClose(): void {
    this.contentEl.replaceChildren();
  }
}
