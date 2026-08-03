import { describe, expect, it, vi } from "vitest";
import type { FetchResult } from "@roubo/plugin-sdk";
import {
  probeAlertCategories,
  type ProbeCategory,
  type ProbeReport,
} from "../alerts/probe-categories.js";

const BASE = "https://api.github.com";
const OWNER = "octo";
const REPO = "widget";
const REPO_URL = `${BASE}/repos/${OWNER}/${REPO}`;
const CODE_URL = `${BASE}/repos/${OWNER}/${REPO}/code-scanning/alerts?per_page=1`;
const SECRET_URL = `${BASE}/repos/${OWNER}/${REPO}/secret-scanning/alerts?per_page=1`;
const DEP_URL = `${BASE}/repos/${OWNER}/${REPO}/dependabot/alerts?per_page=1`;

function makeTransport(map: Record<string, FetchResult | (() => Promise<FetchResult>)>) {
  return vi.fn(async (url: string): Promise<FetchResult> => {
    const entry = map[url];
    if (!entry) throw new Error(`unexpected url ${url}`);
    if (typeof entry === "function") return entry();
    return entry;
  });
}

function ok(): FetchResult {
  return { status: 200, headers: {}, body: "[]" };
}

function status(code: number, body = ""): FetchResult {
  return { status: code, headers: {}, body };
}

function repoSource(externalId: string) {
  return { kind: "repo", externalId };
}

describe("probeAlertCategories", () => {
  it("returns no reports when no categories are requested", async () => {
    const transport = makeTransport({});
    const reports = await probeAlertCategories({
      baseUrl: BASE,
      transport,
      sources: [repoSource("octo/widget")],
      enabledCategories: [],
    });
    expect(reports).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
  });

  it("marks every category as not-enabled when no repo source is configured", async () => {
    const transport = makeTransport({});
    const reports = await probeAlertCategories({
      baseUrl: BASE,
      transport,
      sources: [{ kind: "project", externalId: "octo/#42" }],
      enabledCategories: ["code-scanning", "dependabot"],
    });
    expect(reports).toEqual([
      {
        category: "code-scanning",
        status: "not-enabled",
        detail: "No repository source configured.",
      },
      {
        category: "dependabot",
        status: "not-enabled",
        detail: "No repository source configured.",
      },
    ]);
    expect(transport).not.toHaveBeenCalled();
  });

  it("returns error reports when the repo pre-flight is unreachable (FR-047 safety net)", async () => {
    const transport = makeTransport({ [REPO_URL]: status(404) });
    const reports = await probeAlertCategories({
      baseUrl: BASE,
      transport,
      sources: [repoSource("octo/widget")],
      enabledCategories: ["code-scanning"],
    });
    expect(reports).toEqual([
      { category: "code-scanning", status: "error", detail: "Repository not accessible." },
    ]);
  });

  it("propagates auth failures as scope-missing across every category when pre-flight 401s", async () => {
    const transport = makeTransport({ [REPO_URL]: status(401) });
    const reports = await probeAlertCategories({
      baseUrl: BASE,
      transport,
      sources: [repoSource("octo/widget")],
      enabledCategories: ["code-scanning", "secret-scanning"],
    });
    expect(reports).toEqual([
      {
        category: "code-scanning",
        status: "scope-missing",
        detail: "Token cannot read this repository.",
        httpStatus: 401,
      },
      {
        category: "secret-scanning",
        status: "scope-missing",
        detail: "Token cannot read this repository.",
        httpStatus: 401,
      },
    ]);
  });

  const mapping: Array<[number, ProbeReport]> = [
    [200, { category: "code-scanning", status: "ok", httpStatus: 200 }],
    [
      401,
      {
        category: "code-scanning",
        status: "scope-missing",
        detail: "Token is invalid or expired.",
        httpStatus: 401,
      },
    ],
    [
      403,
      {
        category: "code-scanning",
        status: "scope-missing",
        detail: "Token missing `security_events` scope.",
        httpStatus: 403,
      },
    ],
    [
      404,
      {
        category: "code-scanning",
        status: "not-enabled",
        detail: "Not enabled for this repository.",
        httpStatus: 404,
      },
    ],
    [
      410,
      {
        category: "code-scanning",
        status: "not-enabled",
        detail: "GitHub Advanced Security disabled for this repository.",
        httpStatus: 410,
      },
    ],
    [
      451,
      {
        category: "code-scanning",
        status: "not-enabled",
        detail: "Unavailable for legal reasons.",
        httpStatus: 451,
      },
    ],
    [
      500,
      {
        category: "code-scanning",
        status: "error",
        detail: "Unexpected HTTP 500.",
        httpStatus: 500,
      },
    ],
  ];

  it.each(mapping)(
    "maps HTTP %s on a category probe to the right status",
    async (httpStatus, expected) => {
      const transport = makeTransport({
        [REPO_URL]: ok(),
        [CODE_URL]: status(httpStatus),
      });
      const reports = await probeAlertCategories({
        baseUrl: BASE,
        transport,
        sources: [repoSource("octo/widget")],
        enabledCategories: ["code-scanning"],
      });
      expect(reports).toEqual([expected]);
    },
  );

  it("surfaces a per-probe timeout as { status: 'timed-out', detail: 'Timed out' } (FR-047)", async () => {
    const transport = makeTransport({
      [REPO_URL]: ok(),
      [DEP_URL]: () =>
        new Promise<FetchResult>(() => {
          /* never resolves */
        }),
    });
    const reports = await probeAlertCategories({
      baseUrl: BASE,
      transport,
      sources: [repoSource("octo/widget")],
      enabledCategories: ["dependabot"],
      timeoutMsPerProbe: 10,
    });
    expect(reports).toEqual([{ category: "dependabot", status: "timed-out", detail: "Timed out" }]);
  });

  it("isolates one slow probe via Promise.allSettled so others still resolve (TC-103)", async () => {
    const transport = makeTransport({
      [REPO_URL]: ok(),
      [CODE_URL]: () =>
        new Promise<FetchResult>(() => {
          /* never resolves: exceeds the per-probe cap */
        }),
      [SECRET_URL]: ok(),
      [DEP_URL]: ok(),
    });
    const categories: ProbeCategory[] = ["code-scanning", "secret-scanning", "dependabot"];
    const reports = await probeAlertCategories({
      baseUrl: BASE,
      transport,
      sources: [repoSource("octo/widget")],
      enabledCategories: categories,
      timeoutMsPerProbe: 20,
    });
    expect(reports.map((r) => r.category)).toEqual(categories);
    expect(reports.map((r) => r.status)).toEqual(["timed-out", "ok", "ok"]);
    expect(reports[0]?.detail).toBe("Timed out");
  });

  it("probes every requested category in parallel and uses per_page=1", async () => {
    const transport = makeTransport({
      [REPO_URL]: ok(),
      [CODE_URL]: ok(),
      [SECRET_URL]: status(404),
      [DEP_URL]: status(403),
    });
    const categories: ProbeCategory[] = ["code-scanning", "secret-scanning", "dependabot"];
    const reports = await probeAlertCategories({
      baseUrl: BASE,
      transport,
      sources: [repoSource("octo/widget")],
      enabledCategories: categories,
    });
    expect(reports.map((r) => r.category)).toEqual(categories);
    expect(reports.map((r) => r.status)).toEqual(["ok", "not-enabled", "scope-missing"]);
    // Every probe URL includes per_page=1; only the four expected URLs were hit.
    const hitUrls = transport.mock.calls.map(([url]) => url);
    expect(hitUrls).toContain(REPO_URL);
    expect(hitUrls).toContain(CODE_URL);
    expect(hitUrls).toContain(SECRET_URL);
    expect(hitUrls).toContain(DEP_URL);
  });

  it("trims trailing slashes on the base URL so GHE configs build clean URLs", async () => {
    const transport = makeTransport({
      [REPO_URL]: ok(),
      [CODE_URL]: ok(),
    });
    await probeAlertCategories({
      baseUrl: `${BASE}/`,
      transport,
      sources: [repoSource("octo/widget")],
      enabledCategories: ["code-scanning"],
    });
    expect(transport).toHaveBeenCalledWith(REPO_URL, expect.any(Object));
    expect(transport).toHaveBeenCalledWith(CODE_URL, expect.any(Object));
  });

  it("forwards allowSelfSignedTls on every request when set", async () => {
    const transport = makeTransport({
      [REPO_URL]: ok(),
      [CODE_URL]: ok(),
    });
    await probeAlertCategories({
      baseUrl: BASE,
      transport,
      sources: [repoSource("octo/widget")],
      enabledCategories: ["code-scanning"],
      allowSelfSignedTls: true,
    });
    for (const [, init] of transport.mock.calls) {
      expect(init?.allowSelfSignedTls).toBe(true);
    }
  });
});
