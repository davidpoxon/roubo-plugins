import type { FetchInit, HostClient } from "@roubo/plugin-sdk";

/**
 * Convert standard `HeadersInit` shapes into the flat record `host.fetch` expects.
 */
function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([k, v]) => [k, v]));
  }
  return { ...(headers as Record<string, string>) };
}

function bodyToString(body: BodyInit | null | undefined): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    );
  }
  // URLSearchParams, FormData, Blob — Octokit does not send these for GitHub APIs.
  return String(body);
}

/**
 * Build a `fetch`-compatible function that routes all requests through `host.fetch`.
 * The returned function is suitable for `new Octokit({ request: { fetch: adapter } })`.
 *
 * The host preserves raw response headers (notably `etag`, `retry-after`, and
 * `x-ratelimit-*`), which `githubRequest` reads for ETag caching and backoff.
 */
export function createHostFetchAdapter(
  host: HostClient,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async function hostFetch(input, init) {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;

    const fetchInit: FetchInit = {};
    const method = init?.method ?? (input instanceof Request ? input.method : undefined);
    if (method) fetchInit.method = method;
    const headers = normalizeHeaders(
      init?.headers ?? (input instanceof Request ? (input.headers as HeadersInit) : undefined),
    );
    if (Object.keys(headers).length > 0) fetchInit.headers = headers;
    const body = bodyToString(init?.body);
    if (body !== undefined) fetchInit.body = body;

    const result = await host.fetch(url, fetchInit);

    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(result.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const v of value) responseHeaders.append(name, v);
      } else {
        responseHeaders.set(name, value);
      }
    }

    // 1xx / 204 / 304 must have null body. Sending an empty string trips the Response constructor.
    const bodyForResponse =
      result.status === 204 || result.status === 304 || result.status < 200
        ? null
        : (result.body ?? "");

    return new Response(bodyForResponse, {
      status: result.status,
      headers: responseHeaders,
    });
  };
}
