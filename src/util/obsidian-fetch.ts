/**
 * fetch over Obsidian's requestUrl: CORS-free (a main-process request), which
 * direct renderer fetch to api.anthropic.com — or to a model server on
 * another machine — is not guaranteed to be.
 *
 * requestUrl has no cancellation, so an AbortSignal can't stop the request
 * itself; what it CAN do is release the caller. That is the half that
 * matters: every timeout in the model providers (a 1.5s reachability probe,
 * a bounded completion) is an abort, and before this honored the signal a
 * probe against an unroutable address simply waited out the OS's connect
 * timeout — the "fail in 1.5s" guarantee was only true in tests. The
 * abandoned request finishes or dies on its own; its result is dropped.
 */

export interface RequestUrlLike {
  (req: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string | ArrayBuffer;
    throw?: boolean;
  }): Promise<{ status: number; headers: Record<string, string>; arrayBuffer: ArrayBuffer }>;
}

export function makeObsidianFetch(requestUrl: RequestUrlLike): typeof fetch {
  return async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h instanceof Headers) h.forEach((v, k) => (headers[k] = v));
    else if (Array.isArray(h)) for (const [k, v] of h) headers[k] = v;
    else if (h) Object.assign(headers, h as Record<string, string>);

    const signal = init?.signal ?? undefined;
    const aborted = () => new DOMException("The operation was aborted.", "AbortError");
    if (signal?.aborted) throw aborted();

    const request = requestUrl({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : (init?.body as ArrayBuffer | undefined),
      throw: false,
    });

    const resp = signal
      ? await new Promise<Awaited<typeof request>>((resolve, reject) => {
          const onAbort = () => reject(aborted());
          signal.addEventListener("abort", onAbort, { once: true });
          request.then(
            (r) => {
              signal.removeEventListener("abort", onAbort);
              resolve(r);
            },
            (err: unknown) => {
              signal.removeEventListener("abort", onAbort);
              reject(err instanceof Error ? err : new Error(String(err)));
            },
          );
        })
      : await request;
    return new Response(resp.arrayBuffer, { status: resp.status, headers: resp.headers });
  };
}
