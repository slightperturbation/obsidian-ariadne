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

    new Setting(containerEl).setName("Margin").setHeading();

    new Setting(containerEl)
      .setName("Related notes while writing")
      .setDesc("Show the Margin: notes related to what you're writing, in the right sidebar.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableMargin).onChange(async (v) => {
          this.plugin.settings.enableMargin = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Ghost link suggestions")
      .setDesc("Faint inline [[link]] suggestions after a typing pause. Tab accepts, Esc dismisses.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableGhostText).onChange(async (v) => {
          this.plugin.settings.enableGhostText = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Suggestion reticence")
      .setDesc("How semantically close a note must be before a ghost link is offered. Higher = quieter.")
      .addSlider((s) =>
        s
          .setLimits(0.5, 0.9, 0.01)
          .setValue(this.plugin.settings.ghostMinCosine)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.ghostMinCosine = v;
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
      .setName("Claude model")
      .setDesc(
        "Model for reasoning tasks (scaffolds, connective phrasing). Default claude-haiku-4-5 is cheapest; use claude-opus-4-8 for higher-quality scaffolds.",
      )
      .addText((t) =>
        t.setValue(this.plugin.settings.claudeModel).onChange(async (v) => {
          this.plugin.settings.claudeModel = v.trim() || "claude-haiku-4-5";
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Session cost limit")
      .setDesc("Reasoning calls stop once this much (USD) has been spent this session. 0 = no limit.")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.costLimitUsd)).onChange(async (v) => {
          const parsed = Number(v);
          this.plugin.settings.costLimitUsd = Number.isFinite(parsed) && parsed >= 0 ? parsed : 2;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Local model endpoint")
      .setDesc("OpenAI-compatible endpoint (home-network only; used opportunistically, never required).")
      .addText((t) =>
        t.setValue(this.plugin.settings.localEndpoint).onChange(async (v) => {
          this.plugin.settings.localEndpoint = v.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName("Filing").setHeading();

    new Setting(containerEl)
      .setName("Attachments folder")
      .setDesc("Where the attachments sweep moves root-dumped images, PDFs, and media.")
      .addText((t) =>
        t.setValue(this.plugin.settings.attachmentsFolder).onChange(async (v) => {
          this.plugin.settings.attachmentsFolder = v.trim();
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
