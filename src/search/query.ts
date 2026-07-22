export interface QueryFilters {
  /** note-type filter, e.g. `type:permanent`. */
  type?: string;
  /** folder scope, e.g. `in:Research`. */
  folder?: string;
  /** ISO date lower bound, e.g. `since:2024-01`. */
  since?: string;
}

export interface ParsedQuery {
  /** Free-text remainder after operators and phrases are removed. */
  text: string;
  /** Exact phrases the user quoted. */
  phrases: string[];
  filters: QueryFilters;
}

const OPERATOR = /\b(type|in|since):("[^"]+"|\S+)/gi;
const PHRASE = /"([^"]+)"/g;

const unquote = (s: string): string => s.replace(/^"(.*)"$/, "$1");

/**
 * Parse the Line's single-line grammar. Operators (`type:`, `in:`, `since:`)
 * and "quoted phrases" are extracted; whatever remains is the free-text query.
 * The grammar is deliberately invisible until used — this parser degrades to a
 * plain-text query when no operators are present.
 */
export function parseQuery(raw: string): ParsedQuery {
  const filters: QueryFilters = {};

  let rest = raw.replace(OPERATOR, (_match, key: string, value: string) => {
    const v = unquote(value);
    switch (key.toLowerCase()) {
      case "type":
        filters.type = v;
        break;
      case "in":
        filters.folder = v;
        break;
      case "since":
        filters.since = v;
        break;
    }
    return " ";
  });

  const phrases: string[] = [];
  rest = rest.replace(PHRASE, (_match, phrase: string) => {
    phrases.push(phrase.trim());
    return " ";
  });

  const text = rest.replace(/\s+/g, " ").trim();
  return { text, phrases, filters };
}
