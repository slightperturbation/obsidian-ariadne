/**
 * Ariadne's agent gateway as a standalone service: the same core the plugin
 * uses, run against a synced copy of the vault on an always-on machine.
 *
 *   node gateway.cjs /path/to/gateway.json
 */
import { promises as fs } from "node:fs";
import * as nodePath from "node:path";
import { createGatewayServer, type ClientToken } from "./http";
import { underFolder, type LevelPolicy } from "./levels";
import { FileLedger, NodeIO } from "./node-io";
import { Gateway } from "./service";

interface Config {
  vault: string;
  stateDir: string;
  port?: number;
  /** Addresses to listen on. Default: loopback only. */
  bind?: string[];
  /** Extra Host header values to accept (e.g. a tailnet name with port). */
  hosts?: string[];
  policy: LevelPolicy;
  itineraryFolderNames?: string[];
  clients: ClientToken[];
}

async function main(): Promise<void> {
  const file = process.argv[2] ?? process.env.ARIADNE_GATEWAY_CONFIG;
  if (!file) throw new Error("usage: gateway.cjs <config.json>");
  const config = JSON.parse(await fs.readFile(file, "utf8")) as Config;
  if (!config.vault || !config.stateDir || !config.policy?.agentFolder) {
    throw new Error("config needs vault, stateDir and policy.agentFolder");
  }
  if (!Array.isArray(config.clients) || config.clients.some((c) => !c.token || c.token.length < 24)) {
    throw new Error("every client needs a token of at least 24 characters");
  }
  await fs.mkdir(config.stateDir, { recursive: true });
  await fs.mkdir(nodePath.join(config.vault, config.policy.agentFolder), { recursive: true });

  const sealed = config.policy.sealedFolders ?? [];
  const io = new NodeIO(config.vault, (p) => sealed.some((f) => underFolder(p, f)));
  const auditFile = nodePath.join(config.stateDir, "audit.jsonl");
  const gateway = new Gateway({
    io,
    policy: config.policy,
    ledger: new FileLedger(nodePath.join(config.stateDir, "ledger.json")),
    itineraryFolderNames: config.itineraryFolderNames ?? ["Travel"],
    audit: (entry) => {
      void fs.appendFile(auditFile, `${JSON.stringify(entry)}\n`).catch(() => {});
    },
  });

  const port = config.port ?? 8765;
  const binds = config.bind?.length ? config.bind : ["127.0.0.1"];
  const hosts = new Set<string>([`localhost:${port}`, `127.0.0.1:${port}`, ...(config.hosts ?? [])]);
  for (const b of binds) hosts.add(`${b}:${port}`);
  for (const address of binds) {
    const server = createGatewayServer({ gateway, clients: config.clients, allowedHosts: [...hosts] });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, address, resolve);
    });
    process.stdout.write(`ariadne-gateway listening on ${address}:${port}\n`);
  }
  const health = await gateway.health();
  // Counts only — never names or content.
  process.stdout.write(`vault ready: ${JSON.stringify(health)}\n`);

  // The rules may have changed with this version: release what they no longer hold.
  const released = await gateway.submissions.recheck().catch(() => 0);
  if (released > 0) process.stdout.write(`re-check released ${released} held item(s)\n`);

  // Pick up review decisions that arrived through Sync.
  setInterval(() => {
    void gateway.submissions.sweep().catch((err) => process.stderr.write(`sweep failed: ${String(err)}\n`));
  }, 60_000).unref();
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
