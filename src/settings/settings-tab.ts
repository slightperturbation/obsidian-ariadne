import { App, PluginSettingTab, Setting } from "obsidian";
import type AriadnePlugin from "../main";
import type { AriadneSettings } from "./settings";

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
      .setDesc(
        "Use local embeddings alongside lexical (BM25) search. Lexical always works even without a model. Takes effect after reloading the plugin.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableSemantic).onChange(async (v) => {
          this.plugin.settings.enableSemantic = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("This device's role")
      .setDesc(
        "One device should own the index: it runs the embedding model and writes the index files, which the others read over Sync. " +
          "Automatic makes desktops owners and phones/tablets readers — a reader still searches and still shows related notes, " +
          "it just never downloads a model or writes index files. Set an iPad to Owner if you have no desktop. " +
          "Takes effect after reloading the plugin.",
      )
      .addDropdown((d) =>
        d
          .addOptions({ auto: "Automatic", owner: "Owner (indexes)", consumer: "Reader (synced index)" })
          .setValue(this.plugin.settings.deviceRole)
          .onChange(async (v) => {
            this.plugin.settings.deviceRole = v as AriadneSettings["deviceRole"];
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

    new Setting(containerEl)
      .setName("Embedding model")
      .setDesc(
        "Local model used for semantic search, downloaded once on first use. Takes effect after reloading the plugin.",
      )
      .addText((t) =>
        t.setValue(this.plugin.settings.embeddingModel).onChange(async (v) => {
          this.plugin.settings.embeddingModel = v.trim() || "bge-small-en-v1.5";
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
      .setName("Tension and echo cards")
      .setDesc(
        "Surface contradictions ('this disagrees with…') and repetitions ('you've written this before') in the Margin. " +
          "Quiet interrupts only when nearly certain. Checks use the reasoning model in the background — cached, " +
          "capped per session, and they stop at your cost limit.",
      )
      .addDropdown((d) =>
        d
          .addOptions({ off: "Off", quiet: "Quiet (default)", eager: "Eager" })
          .setValue(this.plugin.settings.tensionMode)
          .onChange(async (v) => {
            this.plugin.settings.tensionMode = v as AriadneSettings["tensionMode"];
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Margin serendipity")
      .setDesc(
        "How boldly the Margin presents its cards. Lower = quieter marginalia, higher = more insistent. " +
          "Shapes emphasis only — never hides a result.",
      )
      .addSlider((sl) =>
        sl
          .setLimits(0, 1, 0.05)
          .setValue(this.plugin.settings.marginSerendipity)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.marginSerendipity = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Search serendipity")
      .setDesc("The same dial for the search results' Related layer.")
      .addSlider((sl) =>
        sl
          .setLimits(0, 1, 0.05)
          .setValue(this.plugin.settings.lineSerendipity)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.lineSerendipity = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Ghost link suggestions")
      .setDesc(
        "Faint inline [[link]] suggestions after a typing pause. Tab accepts, Esc dismisses; on a phone, tap the suggestion to accept and keep typing to dismiss.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableGhostText).onChange(async (v) => {
          this.plugin.settings.enableGhostText = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Suggestion reticence")
      .setDesc(
        "How semantically close a note must be before a ghost link is offered (raw cosine). ~0.75 is chatty, ~0.85 is quiet, ~0.9+ is near-silent.",
      )
      .addSlider((s) =>
        s
          .setLimits(0.6, 0.95, 0.01)
          .setValue(this.plugin.settings.ghostMinCosine)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.ghostMinCosine = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName("Models").setHeading();


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
      .setName("Local model URL")
      .setDesc(
        "OpenAI-compatible server on your home network (Ollama, LM Studio, llama.cpp) — e.g. http://gemma.local:11434/v1. " +
          "Used opportunistically for cheap tasks when reachable; everything works without it. Leave blank to disable.",
      )
      .addText((t) =>
        t
          .setPlaceholder("http://…:11434/v1")
          .setValue(this.plugin.settings.gemmaBaseUrl)
          .onChange(async (v) => {
            this.plugin.settings.gemmaBaseUrl = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Local model name")
      .setDesc("As the local server knows it, e.g. gemma3:27b.")
      .addText((t) =>
        t.setValue(this.plugin.settings.gemmaModel).onChange(async (v) => {
          this.plugin.settings.gemmaModel = v.trim() || "gemma3:27b";
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Routing")
      .setDesc(
        "Automatic sends quick tasks (link phrasing, tension checks) to the local box when it's awake and " +
          "quality-sensitive work (scaffolds, splits, MoCs) to Claude. The glyph always says which brain answered.",
      )
      .addDropdown((d) =>
        d
          .addOptions({
            auto: "Automatic (recommended)",
            cloud: "Cloud only",
            local: "Local when reachable",
          })
          .setValue(this.plugin.settings.routingMode)
          .onChange(async (v) => {
            this.plugin.settings.routingMode = v as AriadneSettings["routingMode"];
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

    new Setting(containerEl)
      .setName("Inbox folder")
      .setDesc("Where capture lands; Triage Inbox proposes one disposition per note here.")
      .addText((t) =>
        t.setValue(this.plugin.settings.inboxFolder).onChange(async (v) => {
          this.plugin.settings.inboxFolder = v.trim() || "Inbox";
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Archive folder")
      .setDesc("Where triage moves inert notes. Moves are undoable.")
      .addText((t) =>
        t.setValue(this.plugin.settings.archiveFolder).onChange(async (v) => {
          this.plugin.settings.archiveFolder = v.trim() || "Archive";
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
