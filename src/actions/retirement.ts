import { Modal, Notice, normalizePath, type App } from "obsidian";
import type { Logger } from "../util/logger";

/**
 * Guided retirement of the plugins Ariadne replaces (PRD §4.7: "replace
 * Smart Connections and Omnisearch outright — no coexistence period").
 *
 * Everything here is approval-first: the command *shows* what it found and
 * what Ariadne covers instead; nothing is disabled or trashed except by an
 * explicit per-item click. Disabling uses Obsidian's plugin manager (same as
 * toggling in settings — reversible there at any time); the `.smart-env`
 * folder, Smart Connections' embedding cache, goes to the system trash, not
 * rm -rf.
 */

interface Incumbent {
  id: string;
  name: string;
  /** What Ariadne offers in its place — shown so the trade is legible. */
  replacedBy: string;
  /** Data directory worth cleaning up after disable, if any (vault-relative). */
  dataDir?: string;
}

const INCUMBENTS: Incumbent[] = [
  {
    id: "smart-connections",
    name: "Smart Connections",
    replacedBy: "the Margin (related notes, links, tension/echo) and semantic search",
    dataDir: ".smart-env",
  },
  {
    id: "omnisearch",
    name: "Omnisearch",
    replacedBy: "the Line (fused lexical + semantic search)",
  },
];

/** The undocumented-but-stable plugin manager surface this feature needs. */
interface PluginManager {
  manifests: Record<string, { name: string }>;
  enabledPlugins: Set<string>;
  disablePluginAndSave(id: string): Promise<void>;
}

const pluginsOf = (app: App): PluginManager | undefined =>
  (app as unknown as { plugins?: PluginManager }).plugins;

export interface IncumbentStatus {
  incumbent: Incumbent;
  installed: boolean;
  enabled: boolean;
  dataDirExists: boolean;
}

export async function surveyIncumbents(app: App): Promise<IncumbentStatus[]> {
  const plugins = pluginsOf(app);
  const out: IncumbentStatus[] = [];
  for (const incumbent of INCUMBENTS) {
    const installed = !!plugins?.manifests[incumbent.id];
    const enabled = plugins?.enabledPlugins.has(incumbent.id) ?? false;
    const dataDirExists = incumbent.dataDir
      ? await app.vault.adapter.exists(normalizePath(incumbent.dataDir))
      : false;
    out.push({ incumbent, installed, enabled, dataDirExists });
  }
  return out;
}

export class RetirementModal extends Modal {
  constructor(
    app: App,
    private statuses: IncumbentStatus[],
    private log: Logger,
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
    title.textContent = "Retire replaced plugins";
    root.appendChild(title);

    const actionable = this.statuses.filter((s) => s.enabled || s.dataDirExists);
    if (actionable.length === 0) {
      const done = doc.createElement("div");
      done.classList.add("ariadne-empty");
      done.textContent =
        "Nothing to retire — Smart Connections and Omnisearch are already gone.";
      root.appendChild(done);
      return;
    }

    for (const status of actionable) {
      root.appendChild(this.rowFor(doc, status));
    }

    const note = doc.createElement("div");
    note.classList.add("ariadne-empty");
    note.textContent =
      "Disabling is the same as toggling in Community plugins — reversible there any time. " +
      "Nothing happens without a click.";
    root.appendChild(note);
  }

  private rowFor(doc: Document, status: IncumbentStatus): HTMLElement {
    const { incumbent } = status;
    const row = doc.createElement("div");
    row.classList.add("ariadne-retire-row");

    const text = doc.createElement("div");
    const name = doc.createElement("div");
    name.classList.add("ariadne-row-title");
    name.textContent = incumbent.name;
    const covers = doc.createElement("div");
    covers.classList.add("ariadne-row-snippet");
    covers.textContent = `Covered by ${incumbent.replacedBy}.`;
    text.append(name, covers);
    row.appendChild(text);

    const buttons = doc.createElement("div");
    buttons.classList.add("ariadne-retire-actions");

    if (status.enabled) {
      const disable = doc.createElement("button");
      disable.type = "button";
      disable.textContent = "Disable";
      disable.addEventListener("click", () => {
        void (async () => {
          try {
            await pluginsOf(this.app)?.disablePluginAndSave(incumbent.id);
            new Notice(`${incumbent.name} disabled.`);
            disable.remove();
          } catch (err) {
            this.log.warn(`could not disable ${incumbent.id}: ${String(err)}`);
            new Notice(`Could not disable ${incumbent.name} — see console.`);
          }
        })();
      });
      buttons.appendChild(disable);
    }

    if (status.dataDirExists && incumbent.dataDir) {
      const dir = incumbent.dataDir;
      const clean = doc.createElement("button");
      clean.type = "button";
      clean.textContent = `Trash ${dir}/`;
      clean.addEventListener("click", () => {
        void (async () => {
          try {
            // System trash, so even this is recoverable outside Obsidian.
            const ok = await this.app.vault.adapter.trashSystem(normalizePath(dir));
            if (!ok) throw new Error("system trash unavailable");
            new Notice(`${dir}/ moved to system trash.`);
            clean.remove();
          } catch (err) {
            this.log.warn(`could not trash ${dir}: ${String(err)}`);
            new Notice(`Could not trash ${dir}/ — see console.`);
          }
        })();
      });
      buttons.appendChild(clean);
    }

    row.appendChild(buttons);
    return row;
  }
}
