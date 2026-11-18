import { cleanString, inertQuote, safeTitle } from "./records";

/**
 * The text of a note the agent keeps for the user to read (an itinerary, the
 * page of one booking). The agent supplies lines and, separately, typed
 * links; this turns them into Markdown.
 *
 * The rule that makes it safe: words are never markup. Text that came from a
 * message is made inert, so it cannot become a link, an embed, a tag or
 * HTML. Structure comes only from a small set of line openings, and a link
 * only from a typed part the gateway builds itself — a map from an address,
 * a telephone link from digits, a web link shown with the host it goes to.
 */
export type DigestLink =
  | { kind: "map"; q: string; label?: string }
  | { kind: "tel"; number: string; label?: string }
  | { kind: "wa"; number: string; label?: string }
  | { kind: "mail"; address: string; label?: string }
  | { kind: "web"; url: string; label?: string }
  | { kind: "note"; path: string; label?: string }
  | { kind: "embed"; path: string };

export const MAX_DIGEST_LINES = 600;
export const MAX_DIGEST_LINKS = 400;

const CALLOUTS = new Set(["tip", "warning", "info", "example", "quote", "note", "robot", "success", "question"]);
/** A link is written in a line as ⟦n⟧, its place in the list of links. */
const TOKEN = /⟦(\d{1,3})⟧/g;
const EMBEDDABLE = /\.(?:png|jpe?g|gif|webp|pdf)$/i;

/** A label: inert, and unable to close the brackets it sits in. */
function label(v: unknown, fallback: string): string {
  return inertQuote(v, 80).replace(/[[\]|]/g, " ").replace(/\s+/g, " ").trim() || fallback;
}

function digits(v: unknown): string {
  const d = cleanString(v, 40).replace(/\D/g, "");
  return d.length >= 7 && d.length <= 15 ? d : "";
}

/** A path inside the vault, as a link target: no way up, no markup. */
function vaultPath(v: unknown): string {
  const p = cleanString(v, 300).replace(/\\/g, "/").replace(/^\/+/, "");
  if (!p || /[[\]|#^<>`]/.test(p) || p.split("/").some((s) => s === ".." || s === "." || s === "")) return "";
  return p;
}

/** What a stored file is, by its first bytes — never by what it is called. */
export function sniff(data: Uint8Array): "pdf" | "png" | "jpg" | undefined {
  const at = (i: number) => data[i] ?? -1;
  if (at(0) === 0x25 && at(1) === 0x50 && at(2) === 0x44 && at(3) === 0x46 && at(4) === 0x2d) return "pdf";
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 && at(4) === 0x0d && at(5) === 0x0a) return "png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "jpg";
  return undefined;
}

export const MAX_PAPER_BYTES = 10 * 1024 * 1024;

export function renderLink(link: unknown, agentFolder: string): string {
  if (!link || typeof link !== "object") return "";
  const l = link as Record<string, unknown>;
  switch (l.kind) {
    case "map": {
      const q = cleanString(l.q, 200);
      return q ? `[${label(l.label, "map")}](https://maps.apple.com/?q=${encodeURIComponent(q)})` : "";
    }
    case "tel": {
      const d = digits(l.number);
      // A number written with its country code dials from anywhere; one without is dialled as written.
      const plus = /^\s*\+/.test(cleanString(l.number, 40)) ? "+" : "";
      return d ? `[${label(l.label, `${plus}${d}`)}](tel:${plus}${d})` : label(l.label, "");
    }
    case "wa": {
      const d = digits(l.number);
      return d ? `[${label(l.label, "WhatsApp")}](https://wa.me/${d})` : label(l.label, "");
    }
    case "mail": {
      const a = cleanString(l.address, 120);
      return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(a) ? `[${label(l.label, a)}](mailto:${a})` : label(l.label, "");
    }
    case "web": {
      let url: URL;
      try {
        url = new URL(cleanString(l.url, 400));
      } catch {
        return label(l.label, "");
      }
      if (url.protocol !== "https:" || url.username || url.password || /[()<>\s]/.test(url.href)) return label(l.label, "");
      // Whatever it is called, it says where it goes.
      const host = url.hostname.replace(/^www\./, "");
      const named = label(l.label, "");
      return `[${named && named.toLowerCase() !== host ? `${named} · ${host}` : host}](${url.href})`;
    }
    case "note": {
      const p = vaultPath(l.path).replace(/\.md$/i, "");
      if (!p) return label(l.label, "");
      return `[[${p}|${label(l.label, p.split("/").pop() ?? p)}]]`;
    }
    case "embed": {
      const p = vaultPath(l.path);
      // Only the agent's own papers, and only kinds a note can show.
      if (!p || !p.startsWith(`${agentFolder}/Papers/`) || !EMBEDDABLE.test(p)) return "";
      return `![[${p}]]`;
    }
    default:
      return "";
  }
}

/** One line: its opening kept if it is one of the few allowed, the rest inert, links put in. */
export function renderLine(raw: unknown, links: readonly string[]): string {
  let rest = typeof raw === "string" ? raw.replace(/[\r\n]+/g, " ") : "";
  let open = "";
  const quote = /^> ?/.exec(rest);
  if (quote) {
    open += "> ";
    rest = rest.slice(quote[0].length);
    const callout = /^\[!([a-z]+)\]([+-]?)(?: |$)/i.exec(rest);
    if (callout && CALLOUTS.has(callout[1]!.toLowerCase())) {
      open += `[!${callout[1]!.toLowerCase()}]${callout[2]} `;
      rest = rest.slice(callout[0].length);
    }
  }
  if (/^-{3,}\s*$/.test(rest)) return quote ? open.trimEnd() : "---";
  const heading = /^(#{1,3}) /.exec(rest);
  const item = /^( {0,8})- (\[[ xX]\] )?/.exec(rest);
  if (heading && !quote) {
    open += `${heading[1]} `;
    rest = rest.slice(heading[0].length);
  } else if (item) {
    open += `${" ".repeat(item[1]!.length >= 4 ? 4 : 0)}- ${item[2] ? item[2].toLowerCase() : ""}`;
    rest = rest.slice(item[0].length);
  }
  // The words, made inert, with each ⟦n⟧ replaced by the link the gateway built for it.
  const parts = rest.split(TOKEN);
  let body = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      body += links[Number(parts[i])] ?? "";
      continue;
    }
    const part = parts[i]!;
    // An arrow typed as "->" would otherwise lose its head when angle brackets are made inert.
    // Nor may words open a callout of their own.
    const words = inertQuote(part.replace(/->/g, "→"), 400).replace(/⟦|⟧/g, "").replace(/\[!/g, "[ !");
    // Making text inert trims it; the spaces that set it off from a link are put back.
    body += `${i > 0 && /^\s/.test(part) ? " " : ""}${words}${i < parts.length - 1 && /\s$/.test(part) ? " " : ""}`;
  }
  body = body.replace(/ {2,}/g, " ").trimEnd();
  if (!body) return open.trimEnd();
  return `${open}${body}`;
}

export function renderDigest(lines: readonly unknown[], links: readonly unknown[], agentFolder: string): string {
  const built = links.slice(0, MAX_DIGEST_LINKS).map((l) => renderLink(l, agentFolder));
  return `${lines.map((l) => renderLine(l, built)).join("\n").trimEnd()}\n`;
}

/** Where a digest lives: under the agent's Itineraries folder, at most one folder deep. */
export function digestPath(agentFolder: string, title: unknown, folder: unknown): string {
  const sub = cleanString(folder, 120) ? `${safeTitle(cleanString(folder, 120))}/` : "";
  return `${agentFolder}/Itineraries/${sub}${safeTitle(cleanString(title, 120))}.md`;
}
