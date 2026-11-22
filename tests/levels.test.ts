import { describe, expect, it } from "vitest";
import { cloudAllowed, combinedLevel, levelOf, type LevelPolicy } from "../src/privacy/levels";
import { ModelRouter, type ReasoningProvider } from "../src/model/router";
import { StatusStore } from "../src/core/status";

const policy: LevelPolicy = {
  localOnlyFolders: ["Personal", "Periodic"],
  sealedFolders: ["Personal/Journal"],
};

describe("privacy levels", () => {
  it("derives the level from the folder", () => {
    expect(levelOf("Research/Idea.md", policy)).toBe("shareable");
    expect(levelOf("Personal/Health.md", policy)).toBe("local");
    expect(levelOf("Periodic/Daily/2026-11-16.md", policy)).toBe("local");
    expect(levelOf("Personal/Journal/2026-11-16.md", policy)).toBe("sealed");
    // A folder that merely shares a prefix is not inside it.
    expect(levelOf("Personal Projects/x.md", policy)).toBe("shareable");
  });

  it("lets a property tighten anything, and loosen only outside sealed folders", () => {
    expect(levelOf("Head MRI.md", policy, "local")).toBe("local");
    expect(levelOf("Research/Idea.md", policy, "sealed")).toBe("sealed");
    expect(levelOf("Personal/Recipe.md", policy, "shareable")).toBe("shareable");
    expect(levelOf("Personal/Journal/x.md", policy, "shareable")).toBe("sealed");
    expect(levelOf("Research/Idea.md", policy, "nonsense")).toBe("shareable");
  });

  it("gives derived content the strictest source level", () => {
    expect(combinedLevel(["shareable", "local"])).toBe("local");
    expect(combinedLevel(["local", "sealed", "shareable"])).toBe("sealed");
    expect(combinedLevel([])).toBe("shareable");
    expect(cloudAllowed("shareable")).toBe(true);
    expect(cloudAllowed("local")).toBe(false);
    expect(cloudAllowed("sealed")).toBe(false);
  });
});

function provider(name: string, up = true): ReasoningProvider & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    available: () => up,
    complete: async (prompt) => {
      prompts.push(prompt);
      return { text: name, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    },
  };
}

function router(cloud: ReasoningProvider, local: ReasoningProvider | undefined, mode = "auto") {
  return new ModelRouter({
    provider: cloud,
    local,
    mode: () => mode as "auto" | "cloud" | "local",
    status: new StatusStore(),
    costLimitUsd: () => 0,
    log: { info() {}, warn() {}, error() {}, debug() {} } as never,
    isLocalOnly: (path) => !cloudAllowed(levelOf(path, policy)),
  });
}

describe("the local-only wall", () => {
  it("sends a shareable-only prompt wherever routing says", async () => {
    const cloud = provider("cloud");
    const local = provider("local");
    const r = router(cloud, local);
    expect(await r.run("scaffold", "p", { sources: ["Research/Idea.md"] })).toBe("cloud");
  });

  it("forces a prompt with any local-only source onto the local model", async () => {
    const cloud = provider("cloud");
    const local = provider("local");
    const r = router(cloud, local);
    expect(
      await r.run("scaffold", "p", { sources: ["Research/Idea.md", "Personal/Health.md"] }),
    ).toBe("local");
    expect(cloud.prompts).toHaveLength(0);
  });

  it("fails rather than fall back to the cloud when no local model is reachable", async () => {
    const cloud = provider("cloud");
    const r = router(cloud, provider("local", false));
    await expect(r.run("connective", "p", { sources: ["Periodic/Daily/x.md"] })).rejects.toThrow(
      /local-only/,
    );
    const noLocal = router(cloud, undefined);
    await expect(noLocal.run("connective", "p", { sources: ["Personal/a.md"] })).rejects.toThrow(
      /local-only/,
    );
    expect(cloud.prompts).toHaveLength(0);
  });

  it("holds even when the user picked cloud-only routing", async () => {
    const cloud = provider("cloud");
    const local = provider("local");
    const r = router(cloud, local, "cloud");
    expect(await r.run("scaffold", "p", { sources: ["Personal/a.md"] })).toBe("local");
    expect(cloud.prompts).toHaveLength(0);
  });

  it("never retries a walled prompt on the cloud after a local failure", async () => {
    const cloud = provider("cloud");
    const local: ReasoningProvider = {
      available: () => true,
      complete: async () => {
        throw new Error("local crashed");
      },
    };
    const r = router(cloud, local);
    await expect(r.run("relation", "p", { sources: ["Personal/a.md"] })).rejects.toThrow(
      "local crashed",
    );
    expect(cloud.prompts).toHaveLength(0);
  });
});
