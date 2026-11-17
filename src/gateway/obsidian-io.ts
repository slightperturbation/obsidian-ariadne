import { TFile, normalizePath, type App } from "obsidian";
import { ObsidianVaultIO } from "../actions/vault-io";
import type { GatewayIO } from "./io";

/** The gateway's vault surface, inside Obsidian. */
export class ObsidianGatewayIO extends ObsidianVaultIO implements GatewayIO {
  constructor(private vaultApp: App) {
    super(vaultApp);
  }

  async list(folder: string): Promise<string[]> {
    const prefix = folder ? `${normalizePath(folder)}/` : "";
    return this.vaultApp.vault
      .getMarkdownFiles()
      .map((f) => f.path)
      .filter((p) => p.startsWith(prefix))
      .sort();
  }

  async mtime(path: string): Promise<number | null> {
    const f = this.vaultApp.vault.getAbstractFileByPath(normalizePath(path));
    return f instanceof TFile ? f.stat.mtime : null;
  }
}
