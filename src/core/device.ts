/**
 * What this device is allowed to do.
 *
 * Ariadne treats a vault as having one **index owner** — the machine that runs
 * the embedding model and writes the index shards — and any number of
 * **consumers** that read those shards over Sync. A phone is a consumer by
 * default, and that single decision removes almost every mobile hazard at
 * once: no 23 MB ONNX runtime read into memory, no ~30 MB model download over
 * cellular, no full-index snapshot crossing the worker boundary every few
 * seconds, and no two devices writing the same shard files for Sync to
 * conflict over.
 *
 * What a consumer keeps is more than it sounds like. Lexical search is fully
 * local and needs no model. And semantic *relatedness* still works, because
 * the note you're reading was already embedded by the owner — the Margin
 * queries with those stored vectors rather than embedding anything new. Only
 * free-text semantic search genuinely needs a model on-device.
 *
 * Kept free of Obsidian imports so the policy is unit-testable; `main.ts`
 * supplies `isMobile` from `Platform`.
 */

/** How the user has pinned this device's role, if at all. */
export type DeviceRoleSetting = "auto" | "owner" | "consumer";

export interface PolicyInputs {
  isMobile: boolean;
  deviceRole: DeviceRoleSetting;
  enableSemantic: boolean;
}

export interface DevicePolicy {
  role: "owner" | "consumer";
  /** Write index shards to `.obsidian/plugins/ariadne/index/`. */
  writesIndex: boolean;
  /** Load the ONNX runtime + embedding model. Expensive; owners only. */
  loadsModel: boolean;
  /**
   * Assume touch: no hardware modifier keys, no hover, no Tab/Escape. Every
   * capability gated behind a modifier needs a visible affordance here.
   */
  touch: boolean;
}

export function devicePolicy(inputs: PolicyInputs): DevicePolicy {
  const role =
    inputs.deviceRole === "auto"
      ? inputs.isMobile
        ? "consumer"
        : "owner"
      : inputs.deviceRole;
  return {
    role,
    writesIndex: role === "owner",
    // Semantic can be switched off entirely; and a consumer never loads a
    // model even when semantic is on, since it reads the owner's vectors.
    loadsModel: role === "owner" && inputs.enableSemantic,
    touch: inputs.isMobile,
  };
}
