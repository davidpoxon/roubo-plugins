import { describe, expect, it, vi } from "vitest";
import type { FetchInit, FetchResult, HostClient } from "@roubo/plugin-sdk";
import { createHostFetchAdapter } from "../host-fetch-adapter.js";

function makeMockHost(respond: (url: string, init: FetchInit) => FetchResult): {
  host: HostClient;
  calls: Array<{ url: string; init: FetchInit }>;
} {
  const calls: Array<{ url: string; init: FetchInit }> = [];
  const fetchMock = vi.fn(async (url: string, init?: FetchInit) => {
    const initVal = init ?? {};
    calls.push({ url, init: initVal });
    return respond(url, initVal);
  });
  const host: HostClient = {
    fetch: fetchMock as unknown as HostClient["fetch"],
    credentials: {
      get: vi.fn() as unknown as HostClient["credentials"]["get"],
      set: vi.fn() as unknown as HostClient["credentials"]["set"],
    },
    logger: {
      info: vi.fn() as unknown as HostClient["logger"]["info"],
      warn: vi.fn() as unknown as HostClient["logger"]["warn"],
      error: vi.fn() as unknown as HostClient["logger"]["error"],
    },
  };
  return { host, calls };
}

describe("host-fetch-adapter", () => {
  it("forwards method, headers, and body to host.fetch", async () => {
    const { host, calls } = makeMockHost(() => ({
      status: 201,
      headers: { "content-type": "application/json", etag: '"v1"' },
      body: '{"ok":true}',
    }));
    const adapter = createHostFetchAdapter(host);

    const res = await adapter("https://api.github.com/repos/foo/bar/issues", {
      method: "POST",
      headers: { authorization: "Bearer xyz", "if-none-match": '"prev"' },
      body: '{"a":1}',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/repos/foo/bar/issues");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toEqual({
      authorization: "Bearer xyz",
      "if-none-match": '"prev"',
    });
    expect(calls[0].init.body).toBe('{"a":1}');

    expect(res.status).toBe(201);
    expect(res.headers.get("etag")).toBe('"v1"');
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("preserves etag and retry-after headers from the response", async () => {
    const { host } = makeMockHost(() => ({
      status: 429,
      headers: { etag: '"abc"', "retry-after": "30", "x-ratelimit-remaining": "0" },
      body: "",
    }));
    const adapter = createHostFetchAdapter(host);

    const res = await adapter("https://api.github.com/foo");
    expect(res.status).toBe(429);
    expect(res.headers.get("etag")).toBe('"abc"');
    expect(res.headers.get("retry-after")).toBe("30");
    expect(res.headers.get("x-ratelimit-remaining")).toBe("0");
  });

  it("normalises Headers and array headers", async () => {
    const { host, calls } = makeMockHost(() => ({ status: 200, headers: {}, body: "" }));
    const adapter = createHostFetchAdapter(host);

    const h = new Headers();
    h.set("authorization", "Bearer xyz");
    await adapter("https://api.github.com/foo", { headers: h });
    expect(calls[0].init.headers).toEqual({ authorization: "Bearer xyz" });

    await adapter("https://api.github.com/foo", {
      headers: [["x-custom", "v"]],
    });
    expect(calls[1].init.headers).toEqual({ "x-custom": "v" });
  });

  it("does not send a body to the Response constructor for 304", async () => {
    const { host } = makeMockHost(() => ({ status: 304, headers: { etag: '"v"' }, body: "" }));
    const adapter = createHostFetchAdapter(host);
    const res = await adapter("https://api.github.com/foo");
    expect(res.status).toBe(304);
  });

  it("forwards allowSelfSignedTls from the resolver when it returns true", async () => {
    const { host, calls } = makeMockHost(() => ({ status: 200, headers: {}, body: "" }));
    const adapter = createHostFetchAdapter(host, () => true);
    await adapter("https://api.github.com/foo");
    expect(calls[0].init.allowSelfSignedTls).toBe(true);
  });

  it("omits allowSelfSignedTls when the resolver returns false or is not supplied", async () => {
    const { host, calls } = makeMockHost(() => ({ status: 200, headers: {}, body: "" }));
    const adapterFalse = createHostFetchAdapter(host, () => false);
    await adapterFalse("https://api.github.com/foo");
    expect("allowSelfSignedTls" in calls[0].init).toBe(false);

    const adapterDefault = createHostFetchAdapter(host);
    await adapterDefault("https://api.github.com/bar");
    expect("allowSelfSignedTls" in calls[1].init).toBe(false);
  });

  it("re-evaluates the resolver on every call", async () => {
    const { host, calls } = makeMockHost(() => ({ status: 200, headers: {}, body: "" }));
    let allow = false;
    const adapter = createHostFetchAdapter(host, () => allow);
    await adapter("https://api.github.com/first");
    allow = true;
    await adapter("https://api.github.com/second");
    expect("allowSelfSignedTls" in calls[0].init).toBe(false);
    expect(calls[1].init.allowSelfSignedTls).toBe(true);
  });
});
