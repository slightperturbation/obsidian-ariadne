import { App, PluginSettingTab, Setting } from "obsidian";
import type AriadnePlugin from "../main";
import type { BrainPreference } from "./settings";

export class AriadneSettingTab extends PluginSettingTab {
  private plugin: AriadnePlugin;

  constructor(app: App, plugin: AriadnePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Indexing").setHeading();

    new Setting(containerEl)
      .setName("Enable semantic search")
      .setDesc("Use local embeddings alongside lexical (BM25) search. Lexical always works even without a model.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableSemantic).onChange(async (v) => {
          this.plugin.settings.enableSemantic = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Index on startup")
      .setDesc("Bring the index up to date when the vault opens.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.indexOnStartup).onChange(async (v) => {
          this.plugin.settings.indexOnStartup = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName("Models").setHeading();

    new Setting(containerEl)
      .setName("Reasoning brain")
      .setDesc("Which model handles MoCs, splits, scaffolding, and connective phrasing.")
      .addDropdown((d) =>
        d
          .addOptions({
            "cloud-first": "Claude API first",
            "local-first": "Local first",
            smart: "Smart per-task",
          })
          .setValue(this.plugin.settings.brain)
          .onChange(async (v) => {
            this.plugin.settings.brain = v as BrainPreference;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Claude API key")
      .setDesc("Stored in this vault's plugin data (data.json). Leave blank to disable cloud reasoning.")
      .addText((t) => {
        t.setPlaceholder("sk-ant-…")
          .setValue(this.plugin.settings.claudeApiKey)
          .onChange(async (v) => {
            this.plugin.settings.claudeApiKey = v.trim();
            await this.plugin.saveSettings();
          });
        t.inputEl.type = "password";
      });

    new Setting(containerEl)
      .setName("Local model endpoint")
      .setDesc("OpenAI-compatible endpoint (home-network only; used opportunistically, never required).")
      .addText((t) =>
        t.setValue(this.plugin.settings.localEndpoint).onChange(async (v) => {
          this.plugin.settings.localEndpoint = v.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName("Advanced").setHeading();

    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc("Verbose console logging for development.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.debugLogging).onChange(async (v) => {
          this.plugin.settings.debugLogging = v;
          await this.plugin.saveSettings();
        }),
      );
  }
}
