import { App, Modal, Notice } from "obsidian";

export interface ItemAction {
  label: string;
  /** Style as the destructive choice (archive, delete). */
  destructive?: boolean;
  /**
   * This action opens another modal or a full flow: close THIS modal first.
   * Closing a modal underneath a newer one pops keymap scopes out of order —
   * Escape and focus land on the wrong surface.
   */
  closesModal?: boolean;
  /**
   * Two-step confirmation: the first click arms the button with this label
   * (styled destructive); only a second click within 5 s runs. For actions
   * whose mistake is expensive — publishing a held note is the archetype.
   */
  confirmLabel?: string;
  /** Runs on click. Return true to remove the row (the item is handled). */
  run(): Promise<boolean> | boolean;
}

export interface ActionableItem {
  title: string;
  detail?: string;
  actions: ItemAction[];
}

/**
 * A list where each row carries its own choices — the shape of triage, where
 * "accept all" would be wrong by design: the PRD's filing model is one
 * decision per item, each individually reversible. (Contrast ListPreviewModal,
 * which gates a single batch operation.) Nothing happens without a click; the
 * modal closes itself when every row is handled.
 */
export class ItemActionsModal extends Modal {
  constructor(
    app: App,
    private options: { title: string; description?: string; items: ActionableItem[] },
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
      desc.classList.add("ariadne-empty");
      desc.textContent = this.options.description;
      root.appendChild(desc);
    }

    let remaining = this.options.items.length;
    for (const item of this.options.items) {
      const row = doc.createElement("div");
      row.classList.add("ariadne-retire-row");

      const text = doc.createElement("div");
      const name = doc.createElement("div");
      name.classList.add("ariadne-row-title");
      name.textContent = item.title;
      text.appendChild(name);
      if (item.detail) {
        const detail = doc.createElement("div");
        detail.classList.add("ariadne-row-snippet");
        detail.textContent = item.detail;
        text.appendChild(detail);
      }
      row.appendChild(text);

      const buttons = doc.createElement("div");
      buttons.classList.add("ariadne-retire-actions");
      for (const action of item.actions) {
        const btn = doc.createElement("button");
        btn.type = "button";
        btn.textContent = action.label;
        if (action.destructive) btn.classList.add("mod-warning");
        btn.addEventListener("click", () => {
          if (action.confirmLabel && btn.dataset.armed !== "1") {
            btn.dataset.armed = "1";
            const original = btn.textContent;
            btn.textContent = action.confirmLabel;
            btn.classList.add("mod-warning");
            window.setTimeout(() => {
              if (btn.dataset.armed === "1") {
                btn.dataset.armed = "";
                btn.textContent = original;
                if (!action.destructive) btn.classList.remove("mod-warning");
              }
            }, 5000);
            return;
          }
          btn.dataset.armed = "";
          void (async () => {
            if (action.closesModal) {
              this.close();
              await Promise.resolve(action.run()).catch((err: unknown) => {
                new Notice(`${action.label} failed — see console.`);
                console.error("[Ariadne]", err);
              });
              return;
            }
            // Guarded and single-flight: a rename that rejects must say so,
            // and a double-click must not archive twice (the second move
            // would land the note in Archive/x 2.md with a second undo).
            if (btn.disabled) return;
            btn.disabled = true;
            try {
              if (await action.run()) {
                row.remove();
                remaining -= 1;
                if (remaining === 0) this.close();
              }
            } catch (err) {
              new Notice(`${action.label} failed — see console.`);
              console.error("[Ariadne]", err);
            } finally {
              btn.disabled = false;
            }
          })();
        });
        buttons.appendChild(btn);
      }
      row.appendChild(buttons);
      root.appendChild(row);
    }
  }
}
