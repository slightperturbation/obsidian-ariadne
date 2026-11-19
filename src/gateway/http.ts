import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Gateway, GatewayError, type Client } from "./service";

export interface ClientToken extends Client {
  token: string;
}

export interface HttpOptions {
  gateway: Gateway;
  clients: readonly ClientToken[];
  /** Host header values accepted (DNS-rebinding guard), lower-case, with port. */
  allowedHosts: readonly string[];
  maxBodyBytes?: number;
  /** Requests per minute, per client. */
  rateLimit?: number;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(text);
}

async function readBody(req: IncomingMessage, max: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > max) throw new GatewayError("bad-request", "request too large");
    chunks.push(buf);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new GatewayError("bad-request", "body is not JSON");
  }
}

/**
 * The gateway over plain HTTP: POST /v1/<tool> with a JSON body and a bearer
 * token. One token per client; the token decides the client's class.
 */
export function createGatewayServer(opts: HttpOptions): Server {
  // Room for one stored file (a ticket of up to 10 MB, written in base64) and its envelope.
  const max = opts.maxBodyBytes ?? 15 * 1024 * 1024;
  const limit = opts.rateLimit ?? 600;
  const windows = new Map<string, { start: number; count: number }>();
  const hosts = new Set(opts.allowedHosts.map((h) => h.toLowerCase()));

  const tools: Record<string, (c: Client, body: never) => Promise<unknown>> = {
    search: (c, b) => opts.gateway.search(c, b),
    read: (c, b) => opts.gateway.read(c, b),
    notes: (c, b) => opts.gateway.notes(c, b),
    get: (c, b) => opts.gateway.get(c, b),
    resolve: (c, b) => opts.gateway.resolve(c, b),
    submit: (c, b) => opts.gateway.submit(c, b),
    status: (c, b) => opts.gateway.status(c, b),
    decide: (c, b) => opts.gateway.decide(c, b),
    recent: (c, b) => opts.gateway.recent(c, b),
    undo: (c, b) => opts.gateway.undo(c, b),
  };

  return createServer((req, res) => {
    void (async () => {
      try {
        const host = (req.headers.host ?? "").toLowerCase();
        if (!hosts.has(host)) return send(res, 403, { error: "host not allowed" });
        const url = new URL(req.url ?? "/", "http://gateway");
        if (req.method === "GET" && url.pathname === "/v1/health") {
          return send(res, 200, { ok: true });
        }
        const auth = req.headers.authorization ?? "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
        const client = token ? opts.clients.find((c) => same(c.token, token)) : undefined;
        if (!client) return send(res, 401, { error: "unauthorized" });

        const now = Date.now();
        const w = windows.get(client.name);
        if (!w || now - w.start > 60_000) windows.set(client.name, { start: now, count: 1 });
        else if (++w.count > limit) return send(res, 429, { error: "rate limit" });

        if (req.method === "GET" && url.pathname === "/v1/status") {
          return send(res, 200, await opts.gateway.health());
        }
        const m = /^\/v1\/([a-z]+)$/.exec(url.pathname);
        const tool = m ? tools[m[1]!] : undefined;
        if (req.method !== "POST" || !tool) return send(res, 404, { error: "no such tool" });
        const body = await readBody(req, max);
        const { token: _t, ...who } = client;
        void _t;
        send(res, 200, await tool(who, body as never));
      } catch (err) {
        if (err instanceof GatewayError) {
          const status = err.code === "forbidden" ? 403 : err.code === "not-found" ? 404 : 400;
          return send(res, status, { error: err.message });
        }
        send(res, 500, { error: "internal error" });
      }
    })();
  });
}
