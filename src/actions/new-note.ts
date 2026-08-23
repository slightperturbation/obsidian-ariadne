import type { ActionProposal } from "./framework";
import { renderScaffold, sanitizeTitle, type ScaffoldResult } from "../model/tasks";

/**
 * Build the create-note proposal from a scaffold. Pure: path resolution and
 * rendering only — the executor validates the path is actually free at accept
 * time. `home` arrives pre-decided by the placement ladder (an existing
 * folder or ""), so there is no hallucinated-path validation left to do.
 */
export function buildNewNoteProposal(input: {
  scaffold: ScaffoldResult;
  home: string;
  isoDate: string;
}): ActionProposal {
  const { scaffold, home } = input;
  const filename = `${sanitizeTitle(scaffold.title)}.md`;
  const path = home ? `${home}/${filename}` : filename;

  return {
    title: `Create note "${scaffold.title}"`,
    description: home ? `in ${home}` : "in the vault root",
    changes: [
      {
        type: "create",
        path,
        after: renderScaffold(scaffold, input.isoDate),
      },
    ],
  };
}
