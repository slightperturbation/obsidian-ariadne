import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, dropRetiredSettings, type AriadneSettings } from "../src/settings/settings";

/** Settings as loadSettings builds them: defaults, then what data.json held. */
const loaded = (stored: Record<string, unknown>): AriadneSettings =>
  Object.assign({}, DEFAULT_SETTINGS, stored) as AriadneSettings;

describe("settings", () => {
  it("keeps journal text on local models unless the owner says otherwise", () => {
    expect(DEFAULT_SETTINGS.journalModelCalls).toBe("local");
  });

  it("drops the retired agent folder and leaves everything else as it was", () => {
    const s = loaded({ agentFolder: "Agent", localOnlyFolders: "Personal" });
    expect(dropRetiredSettings(s)).toBe(true);
    expect("agentFolder" in s).toBe(false);
    expect(s.localOnlyFolders).toBe("Personal");
    expect(dropRetiredSettings(s)).toBe(false);
  });
});
