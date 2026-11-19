/**
 * Looking things up outside the vault: two public reference sites with open
 * programmatic access — Wikivoyage (travel guides: what to see, do, eat) and
 * Wikipedia (facts). No account, no key, no tracking of the reader.
 *
 * This is the one place the vault chat sends anything off the machine, so
 * what is sent is only ever the words of a query or the name of a page, and
 * the owner is asked before each goes (see `allow` in the tools).
 */
export type FetchJson = (url: string) => Promise<unknown>;

export interface WebHit {
  site: "wikivoyage" | "wikipedia";
  title: string;
  url: string;
  snippet: string;
}

const HOST: Record<WebHit["site"], string> = { wikivoyage: "en.wikivoyage.org", wikipedia: "en.wikipedia.org" };
const pageUrl = (site: WebHit["site"], title: string): string => `https://${HOST[site]}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
const plain = (html: string): string => html.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#0?39;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

/** Which page a URL or a "site: Title" names — only pages of the two sites. */
export function parsePage(given: string): { site: WebHit["site"]; title: string } | undefined {
  const raw = given.trim();
  const url = /^https?:\/\/en\.(wikivoyage|wikipedia)\.org\/wiki\/([^?#]+)/i.exec(raw);
  if (url) return { site: url[1]!.toLowerCase() as WebHit["site"], title: decodeURIComponent(url[2]!).replace(/_/g, " ") };
  const named = /^(wikivoyage|wikipedia)\s*[:/]\s*(.+)$/i.exec(raw);
  if (named) return { site: named[1]!.toLowerCase() as WebHit["site"], title: named[2]!.trim() };
  return undefined;
}

export async function searchWeb(query: string, fetchJson: FetchJson, sites: WebHit["site"][] = ["wikivoyage", "wikipedia"]): Promise<WebHit[]> {
  const out: WebHit[] = [];
  for (const site of sites) {
    const q = new URLSearchParams({ action: "query", list: "search", srsearch: query.slice(0, 200), srlimit: "5", format: "json", origin: "*" });
    const data = (await fetchJson(`https://${HOST[site]}/w/api.php?${q.toString()}`)) as { query?: { search?: Array<{ title?: string; snippet?: string }> } };
    for (const hit of data.query?.search ?? []) {
      if (typeof hit.title !== "string") continue;
      out.push({ site, title: hit.title, url: pageUrl(site, hit.title), snippet: plain(hit.snippet ?? "").slice(0, 200) });
    }
  }
  return out;
}

/** A page's text, with its section headings kept as "== See ==" lines. */
export async function readPage(site: WebHit["site"], title: string, fetchJson: FetchJson): Promise<{ title: string; url: string; text: string } | undefined> {
  const q = new URLSearchParams({ action: "query", prop: "extracts", explaintext: "1", exsectionformat: "wiki", redirects: "1", titles: title.slice(0, 200), format: "json", origin: "*" });
  const data = (await fetchJson(`https://${HOST[site]}/w/api.php?${q.toString()}`)) as { query?: { pages?: Record<string, { title?: string; extract?: string; missing?: unknown }> } };
  const page = Object.values(data.query?.pages ?? {})[0];
  if (!page || page.missing !== undefined || typeof page.extract !== "string" || !page.extract.trim()) return undefined;
  const real = page.title ?? title;
  return { title: real, url: pageUrl(site, real), text: page.extract };
}

/** The headings of a page, so that one can be asked for. */
export function sectionsOf(text: string): string[] {
  return [...text.matchAll(/^==\s*([^=\n]+?)\s*==\s*$/gm)].map((m) => m[1]!);
}

/** The part of a page under a heading (through its sub-headings), or from a position. */
export function partOf(text: string, opts: { section?: string; from?: number; size: number }): { part: string; start: number; more: number; found: boolean } {
  let start = Math.max(0, Math.floor(opts.from ?? 0));
  let end = text.length;
  let found = true;
  if (opts.section) {
    const want = opts.section.trim().toLowerCase();
    const heads = [...text.matchAll(/^(=+)\s*([^=\n]+?)\s*=+\s*$/gm)];
    const at = heads.findIndex((h) => h[2]!.toLowerCase() === want) >= 0 ? heads.findIndex((h) => h[2]!.toLowerCase() === want) : heads.findIndex((h) => h[2]!.toLowerCase().includes(want));
    if (at < 0) found = false;
    else {
      const level = heads[at]![1]!.length;
      const next = heads.slice(at + 1).find((h) => h[1]!.length <= level);
      const base = heads[at]!.index ?? 0;
      end = next?.index ?? text.length;
      start = base + Math.max(0, Math.floor(opts.from ?? 0));
    }
  }
  const part = text.slice(start, Math.min(end, start + opts.size));
  return { part, start, more: Math.max(0, end - (start + opts.size)), found };
}
