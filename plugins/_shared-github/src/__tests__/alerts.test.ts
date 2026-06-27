import { describe, expect, it, vi } from "vitest";
import type { FetchInit, FetchResult } from "@roubo/plugin-sdk";
import { fetchCodeScanningAlerts } from "../alerts/code-scanning.js";
import { fetchSecretScanningAlerts } from "../alerts/secret-scanning.js";
import { fetchDependabotAlerts } from "../alerts/dependabot.js";

function makeTransport(map: Record<string, FetchResult>): {
  transport: (url: string, init?: FetchInit) => Promise<FetchResult>;
  calls: Array<{ url: string; init?: FetchInit }>;
} {
  const calls: Array<{ url: string; init?: FetchInit }> = [];
  const transport = vi.fn(async (url: string, init?: FetchInit): Promise<FetchResult> => {
    calls.push({ url, init });
    const res = map[url];
    if (!res) throw new Error(`unexpected url ${url}`);
    return res;
  });
  return { transport, calls };
}

const PAGE1_HEADERS_NEXT = (next: string) => ({ link: `<${next}>; rel="next"` });

describe("fetchCodeScanningAlerts", () => {
  it("requests state=open with the right URL and walks Link headers", async () => {
    const base = "https://api.github.com";
    const page1 = `${base}/repos/foo/bar/code-scanning/alerts?state=open&per_page=2&page=1`;
    const page2 = `${base}/repos/foo/bar/code-scanning/alerts?state=open&per_page=2&page=2`;
    const { transport, calls } = makeTransport({
      [page1]: {
        status: 200,
        headers: PAGE1_HEADERS_NEXT(page2),
        body: JSON.stringify([{ number: 1, html_url: "u1", state: "open", created_at: "t" }]),
      },
      [page2]: {
        status: 200,
        headers: {},
        body: JSON.stringify([{ number: 2, html_url: "u2", state: "open", created_at: "t" }]),
      },
    });

    const out = await fetchCodeScanningAlerts(transport, {
      baseUrl: base,
      owner: "foo",
      repo: "bar",
      perPage: 2,
    });
    expect(out).toHaveLength(2);
    expect(out[0].number).toBe(1);
    expect(out[1].number).toBe(2);
    expect(calls[0].init?.headers).toMatchObject({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    });
    expect(calls[0].init?.method).toBe("GET");
  });

  it("forwards allowSelfSignedTls for GHE-style instances", async () => {
    const base = "https://ghe.example/api/v3/";
    const expected = `https://ghe.example/api/v3/repos/foo/bar/code-scanning/alerts?state=open&per_page=50&page=1`;
    const { transport, calls } = makeTransport({
      [expected]: { status: 200, headers: {}, body: "[]" },
    });
    await fetchCodeScanningAlerts(transport, {
      baseUrl: base,
      owner: "foo",
      repo: "bar",
      allowSelfSignedTls: true,
    });
    expect(calls[0].init?.allowSelfSignedTls).toBe(true);
  });

  it("clamps perPage above 100 and below 1", async () => {
    const base = "https://api.github.com";
    const high = `${base}/repos/foo/bar/code-scanning/alerts?state=open&per_page=100&page=1`;
    const low = `${base}/repos/foo/bar/code-scanning/alerts?state=open&per_page=1&page=1`;
    const { transport } = makeTransport({
      [high]: { status: 200, headers: {}, body: "[]" },
      [low]: { status: 200, headers: {}, body: "[]" },
    });
    await fetchCodeScanningAlerts(transport, {
      baseUrl: base,
      owner: "foo",
      repo: "bar",
      perPage: 500,
    });
    await fetchCodeScanningAlerts(transport, {
      baseUrl: base,
      owner: "foo",
      repo: "bar",
      perPage: 0,
    });
  });
});

describe("fetchSecretScanningAlerts", () => {
  it("hits /secret-scanning/alerts with state=open", async () => {
    const base = "https://api.github.com";
    const url = `${base}/repos/foo/bar/secret-scanning/alerts?state=open&per_page=50&page=1`;
    const { transport } = makeTransport({
      [url]: {
        status: 200,
        headers: {},
        body: JSON.stringify([
          { number: 1, html_url: "u", state: "open", created_at: "t", secret: "ghp_x" },
        ]),
      },
    });
    const out = await fetchSecretScanningAlerts(transport, {
      baseUrl: base,
      owner: "foo",
      repo: "bar",
    });
    expect(out).toHaveLength(1);
    expect(out[0].secret).toBe("ghp_x");
  });
});

describe("fetchDependabotAlerts", () => {
  it("hits /dependabot/alerts with state=open and no page param", async () => {
    // The Dependabot endpoint rejects `page` with a 400 ("Pagination using the
    // `page` parameter is not supported."), unlike code-scanning/secret-scanning.
    // The request URL must carry state=open and per_page but never page=.
    const base = "https://api.github.com";
    const url = `${base}/repos/foo/bar/dependabot/alerts?state=open&per_page=50`;
    const { transport, calls } = makeTransport({
      [url]: {
        status: 200,
        headers: {},
        body: JSON.stringify([{ number: 7, html_url: "u", state: "open", created_at: "t" }]),
      },
    });
    const out = await fetchDependabotAlerts(transport, {
      baseUrl: base,
      owner: "foo",
      repo: "bar",
    });
    expect(out).toHaveLength(1);
    expect(out[0].number).toBe(7);
    expect(calls[0].url).toContain("state=open");
    expect(calls[0].url).toContain("per_page=50");
    // The standalone `page` param is what GitHub rejects; `per_page` is fine.
    expect(calls[0].url).not.toContain("&page=");
  });

  it("walks the cursor-based Link header (after=...) across pages", async () => {
    // Dependabot paginates by opaque cursor, not by incrementing `page`.
    // paginateAlerts must follow the absolute URL in the `Link: rel="next"`
    // header verbatim, including its `after=` cursor.
    const base = "https://api.github.com";
    const page1 = `${base}/repos/foo/bar/dependabot/alerts?state=open&per_page=2`;
    const page2 = `${base}/repos/foo/bar/dependabot/alerts?state=open&per_page=2&after=CURSOR`;
    const { transport, calls } = makeTransport({
      [page1]: {
        status: 200,
        headers: PAGE1_HEADERS_NEXT(page2),
        body: JSON.stringify([{ number: 1, html_url: "u1", state: "open", created_at: "t" }]),
      },
      [page2]: {
        status: 200,
        headers: {},
        body: JSON.stringify([{ number: 2, html_url: "u2", state: "open", created_at: "t" }]),
      },
    });

    const out = await fetchDependabotAlerts(transport, {
      baseUrl: base,
      owner: "foo",
      repo: "bar",
      perPage: 2,
    });
    expect(out.map((a) => a.number)).toEqual([1, 2]);
    expect(calls[1].url).toBe(page2);
  });

  it("surfaces a 400 from the API (e.g. if the page param is reintroduced)", async () => {
    // Guards against regressing back to a `page`-bearing URL: GitHub answers
    // such a request with HTTP 400, which must propagate as a status-bearing
    // error rather than being silently swallowed.
    const base = "https://api.github.com";
    const url = `${base}/repos/foo/bar/dependabot/alerts?state=open&per_page=50`;
    const { transport } = makeTransport({
      [url]: {
        status: 400,
        headers: {},
        body: JSON.stringify({
          message: "Pagination using the `page` parameter is not supported.",
          status: "400",
        }),
      },
    });
    await expect(
      fetchDependabotAlerts(transport, { baseUrl: base, owner: "foo", repo: "bar" }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
