import { endpointLabel } from "../model/providers/gemma";

/**
 * The local models the chat can be answered by: whatever each configured
 * local endpoint says it has installed. The list is asked for, never
 * assumed, so a model pulled a minute ago is there to pick.
 */
export interface ModelGroup {
  url: string;
  /** "this Mac", or the other machine's name. */
  label: string;
  loopback: boolean;
  reachable: boolean;
  models: string[];
}

/** Models that turn text into vectors cannot hold a conversation. */
const NOT_FOR_CHAT = /embed|bge-|nomic|minilm|rerank|whisper|clip/i;

export const choiceKey = (url: string, model: string): string => `${url}|${model}`;

export function parseChoice(value: string): { url: string; model: string } | null {
  const at = value.indexOf("|");
  if (at <= 0 || at === value.length - 1) return null;
  return { url: value.slice(0, at), model: value.slice(at + 1) };
}

export async function listLocalModels(endpoints: string[], fetchImpl: typeof fetch, timeoutMs = 2500): Promise<ModelGroup[]> {
  return Promise.all(
    endpoints.map(async (raw) => {
      const url = raw.trim().replace(/\/+$/, "");
      const base = { url, ...endpointLabel(url) };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetchImpl(`${url}/models`, { signal: controller.signal });
        if (!resp.ok) return { ...base, reachable: false, models: [] };
        const body = (await resp.json()) as { data?: Array<{ id?: unknown }> };
        const models = (body.data ?? [])
          .map((m) => m.id)
          .filter((id): id is string => typeof id === "string" && id.trim() !== "" && !NOT_FOR_CHAT.test(id))
          .sort((a, b) => a.localeCompare(b));
        return { ...base, reachable: true, models: [...new Set(models)] };
      } catch {
        return { ...base, reachable: false, models: [] };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}
