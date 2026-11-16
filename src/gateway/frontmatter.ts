import { parse, stringify } from "yaml";

export interface SplitNote {
  data: Record<string, unknown>;
  body: string;
}

const FM = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Split a note into frontmatter properties and body. Never throws. */
export function splitNote(text: string): SplitNote {
  const m = FM.exec(text);
  if (!m) return { data: {}, body: text };
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = parse(m[1]!);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    /* malformed frontmatter: treat as none */
  }
  return { data, body: text.slice(m[0].length) };
}

/** Serialize flat properties + body back into a note. */
export function joinNote(data: Record<string, unknown>, body: string): string {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    clean[k] = v;
  }
  const yaml = stringify(clean, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n${body.startsWith("\n") ? body.slice(1) : body}`;
}
