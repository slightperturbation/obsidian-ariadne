import type { ChatMessage } from "./engine";

/**
 * A conversation as a note, for when the owner wants one kept. It is marked
 * as what it is — a model's answers, with the notes each rested on — so it
 * is never taken for the owner's own writing.
 */
export function transcriptTitle(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user")?.text ?? "conversation";
  const words = first.replace(/[\\/:*?"<>|#^[\]\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return (words.length > 50 ? `${words.slice(0, 50).trimEnd()}…` : words) || "conversation";
}

export function transcriptMarkdown(messages: ChatMessage[], meta: { date: string; time: string; model: string }): string {
  const link = (path: string) => `[[${path.replace(/\.md$/, "")}]]`;
  const out = [
    "---",
    `created: ${meta.date}`,
    "type: chat-transcript",
    "authorship: ai-assisted",
    `model: ${JSON.stringify(meta.model || "local model")}`,
    "source: Ariadne vault chat",
    "tags: [ai/generated, chat]",
    "---",
    "",
    `> [!robot] A conversation with a local model (${meta.model || "local"}) in the vault chat, ${meta.date} ${meta.time}. The answers are the model's; each names the notes it rested on. Nothing here was checked by you unless you say so.`,
    "",
  ];
  for (const m of messages) {
    if (m.role === "user") {
      out.push("## You", "", m.text.trim(), "");
      continue;
    }
    out.push("## Model", "", m.text.trim(), "");
    if (m.sources?.length) out.push(`Rested on: ${m.sources.map(link).join(" · ")}`, "");
    else if (!m.failed) out.push("Rested on no note.", "");
    for (const p of m.proposals ?? []) {
      const paths = p.changes.map((c) => link(c.path)).join(", ");
      out.push(`> Proposed: ${p.title}${p.description ? ` — ${p.description.replace(/\n/g, " ")}` : ""} (${paths}). Whether it was applied is not recorded here.`, "");
    }
  }
  return `${out.join("\n").trimEnd()}\n`;
}
