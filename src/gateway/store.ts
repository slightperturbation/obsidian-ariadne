import type { GatewayIO } from "./io";
import { parseRecord, type AgentRecord, type RecordKind } from "./records";

/** Folders inside the agent tree that hold the gateway's own files, not records. */
export const REVIEW_DIR = "_review";

/**
 * The records under the agent folder, re-read only when a file's mtime moves.
 * The vault is the source of truth; this is a cache, rebuilt freely.
 */
export class RecordStore {
  private cache = new Map<string, { mtime: number; record: AgentRecord | null }>();

  constructor(
    private io: GatewayIO,
    private agentFolder: string,
  ) {}

  async all(): Promise<AgentRecord[]> {
    const paths = await this.io.list(this.agentFolder);
    const seen = new Set<string>();
    const out: AgentRecord[] = [];
    for (const path of paths) {
      if (path.startsWith(`${this.agentFolder}/${REVIEW_DIR}/`)) continue;
      if (path.startsWith(`${this.agentFolder}/Log/`)) continue;
      seen.add(path);
      const mtime = (await this.io.mtime(path)) ?? 0;
      let entry = this.cache.get(path);
      if (!entry || entry.mtime !== mtime) {
        let record: AgentRecord | null = null;
        try {
          record = parseRecord(path, await this.io.read(path));
        } catch {
          record = null;
        }
        entry = { mtime, record };
        this.cache.set(path, entry);
      }
      if (entry.record) out.push(entry.record);
    }
    for (const path of [...this.cache.keys()]) if (!seen.has(path)) this.cache.delete(path);
    return out;
  }

  async ofKind(kind: RecordKind): Promise<AgentRecord[]> {
    return (await this.all()).filter((r) => r.kind === kind);
  }

  async byId(id: string): Promise<AgentRecord | undefined> {
    return (await this.all()).find((r) => r.id === id);
  }

  invalidate(path: string): void {
    this.cache.delete(path);
  }
}
