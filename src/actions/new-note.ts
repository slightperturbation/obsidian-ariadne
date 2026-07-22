import type { ActionProposal } from "./framework";
import { renderScaffold, sanitizeTitle, type ScaffoldResult } from "../model/tasks";

/**
 * Build the create-note proposal from a scaffold. Pure: path resolution and
 * rendering only — the executor validates the path is actually free at accept
 * time. If the model chose a home folder not in the allowed list (hallucinated
 * path), fall back to the default folder rather than creating stray dirs.
 */
export function buildNewNoteProposal(input: {
  scaffold: ScaffoldResult;
  allowedFolders: string[];
  defaultFolder: string;
  isoDate: string;
}): ActionProposal {
  const { scaffold } = input;
  const home = input.allowedFolders.includes(scaffold.home)
    ? scaffold.home
    : input.defaultFolder;
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
