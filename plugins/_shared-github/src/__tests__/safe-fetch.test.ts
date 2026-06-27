import { describe, expect, it, vi } from "vitest";
import type { FetchInit, FetchResult } from "@roubo/plugin-sdk";
import { fetchCodeScanningAlerts } from "../alerts/code-scanning.js";
import { fetchDependabotAlerts } from "../alerts/dependabot.js";
import { fetchSecretScanningAlerts } from "../alerts/secret-scanning.js";
import { AlertPaginationError } from "../pagination.js";
import { safeFetchAlerts } from "../alerts/safe-fetch.js";

function makeTransport(map: Record<string, FetchResult>) {
  return vi.fn(async (url: string, _init?: FetchInit): Promise<FetchResult> => {
    const res = map[url];
    if (!res) throw new Error(`unexpected url ${url}`);
    return res;
  });
}

const BASE = "https://api.github.com";
const CODE_URL = `${BASE}/repos/foo/bar/code-scanning/alerts?state=open&per_page=50&page=1`;
const SECRET_URL = `${BASE}/repos/foo/bar/secret-scanning/alerts?state=open&per_page=50&page=1`;
const DEP_URL = `${BASE}/repos/foo/bar/dependabot/alerts?state=open&per_page=50`;

describe("safeFetchAlerts", () => {
  it("returns { ok: true, items } when the fetcher resolves", async () => {
    const transport = makeTransport({
      [CODE_URL]: {
        status: 200,
        headers: {},
        body: JSON.stringify([{ number: 1, html_url: "u", state: "open", created_at: "t" }]),
      },
    });
    const result = await safeFetchAlerts("code-scanning", () =>
      fetchCodeScanningAlerts(transport, { baseUrl: BASE, owner: "foo", repo: "bar" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items).toHaveLength(1);
      expect(result.items[0].number).toBe(1);
    }
  });

  it("maps code-scanning 404 to the GHAS-not-enabled cause string (AC #5)", async () => {
    const transport = makeTransport({
      [CODE_URL]: { status: 404, headers: {}, body: "" },
    });
    const result = await safeFetchAlerts("code-scanning", () =>
      fetchCodeScanningAlerts(transport, { baseUrl: BASE, owner: "foo", repo: "bar" }),
    );
    expect(result).toEqual({
      ok: false,
      cause: "Code Scanning unavailable: GHAS not enabled on this repo.",
      status: 404,
      code: "not-found",
    });
  });

  it("maps secret-scanning 451 to the GHAS-private-repo cause string (AC #6)", async () => {
    const transport = makeTransport({
      [SECRET_URL]: { status: 451, headers: {}, body: "" },
    });
    const result = await safeFetchAlerts("secret-scanning", () =>
      fetchSecretScanningAlerts(transport, { baseUrl: BASE, owner: "foo", repo: "bar" }),
    );
    expect(result).toEqual({
      ok: false,
      cause: "Secret Scanning unavailable: requires GitHub Advanced Security on private repos.",
      status: 451,
      code: "feature-disabled",
    });
  });

  it("maps dependabot 403 to the admin-permission cause string", async () => {
    const transport = makeTransport({
      [DEP_URL]: { status: 403, headers: {}, body: "" },
    });
    const result = await safeFetchAlerts("dependabot", () =>
      fetchDependabotAlerts(transport, { baseUrl: BASE, owner: "foo", repo: "bar" }),
    );
    expect(result).toEqual({
      ok: false,
      cause:
        "Dependabot alerts unavailable: token lacks permission to read dependabot alerts on this repo.",
      status: 403,
      code: "insufficient-permission",
    });
  });

  it("classifies 401 per category", async () => {
    const transport = makeTransport({
      [CODE_URL]: { status: 401, headers: {}, body: "" },
      [SECRET_URL]: { status: 401, headers: {}, body: "" },
      [DEP_URL]: { status: 401, headers: {}, body: "" },
    });
    const [c, s, d] = await Promise.all([
      safeFetchAlerts("code-scanning", () =>
        fetchCodeScanningAlerts(transport, { baseUrl: BASE, owner: "foo", repo: "bar" }),
      ),
      safeFetchAlerts("secret-scanning", () =>
        fetchSecretScanningAlerts(transport, { baseUrl: BASE, owner: "foo", repo: "bar" }),
      ),
      safeFetchAlerts("dependabot", () =>
        fetchDependabotAlerts(transport, { baseUrl: BASE, owner: "foo", repo: "bar" }),
      ),
    ]);
    expect(c.ok).toBe(false);
    expect(s.ok).toBe(false);
    expect(d.ok).toBe(false);
    if (!c.ok) {
      expect(c.cause).toMatch(/security_events/);
      expect(c.code).toBe("missing-scope");
    }
    if (!s.ok) {
      expect(s.cause).toMatch(/repo or security_events/);
      expect(s.code).toBe("missing-scope");
    }
    if (!d.ok) {
      expect(d.cause).toMatch(/security_events/);
      expect(d.code).toBe("missing-scope");
    }
  });

  it("classifies 410 / 451 / 429 statuses", async () => {
    const transport = makeTransport({
      [CODE_URL]: { status: 410, headers: {}, body: "" },
      [SECRET_URL]: { status: 451, headers: {}, body: "" },
      [DEP_URL]: { status: 429, headers: {}, body: "" },
    });
    const [c, s, d] = await Promise.all([
      safeFetchAlerts("code-scanning", () =>
        fetchCodeScanningAlerts(transport, { baseUrl: BASE, owner: "foo", repo: "bar" }),
      ),
      safeFetchAlerts("secret-scanning", () =>
        fetchSecretScanningAlerts(transport, { baseUrl: BASE, owner: "foo", repo: "bar" }),
      ),
      safeFetchAlerts("dependabot", () =>
        fetchDependabotAlerts(transport, { baseUrl: BASE, owner: "foo", repo: "bar" }),
      ),
    ]);
    if (!c.ok) expect(c.code).toBe("feature-disabled");
    if (!s.ok) expect(s.code).toBe("feature-disabled");
    if (!d.ok) expect(d.code).toBe("rate-limited");
  });

  it("flags 401 with missingScope=security_events on every category (WU-039)", async () => {
    const transport = makeTransport({
      [CODE_URL]: { status: 401, headers: {}, body: "" },
      [SECRET_URL]: { status: 401, headers: {}, body: "" },
      [DEP_URL]: { status: 401, headers: {}, body: "" },
    });
    const [c, s, d] = await Promise.all([
      safeFetchAlerts("code-scanning", () =>
        fetchCodeScanningAlerts(transport, { baseUrl: BASE, owner: "foo", repo: "bar" }),
      ),
      safeFetchAlerts("secret-scanning", () =>
        fetchSecretScanningAlerts(transport, { baseUrl: BASE, owner: "foo", repo: "bar" }),
      ),
      safeFetchAlerts("dependabot", () =>
        fetchDependabotAlerts(transport, { baseUrl: BASE, owner: "foo", repo: "bar" }),
      ),
    ]);
    if (!c.ok) expect(c.missingScope).toBe("security_events");
    if (!s.ok) expect(s.missingScope).toBe("security_events");
    if (!d.ok) expect(d.missingScope).toBe("security_events");
  });

  it("does not set missingScope on non-401 failures (WU-039)", async () => {
    const transport = makeTransport({
      [CODE_URL]: { status: 404, headers: {}, body: "" },
      [SECRET_URL]: { status: 451, headers: {}, body: "" },
      [DEP_URL]: { status: 403, headers: {}, body: "" },
    });
    const [c, s, d] = await Promise.all([
      safeFetchAlerts("code-scanning", () =>
        fetchCodeScanningAlerts(transport, { baseUrl: BASE, owner: "foo", repo: "bar" }),
      ),
      safeFetchAlerts("secret-scanning", () =>
        fetchSecretScanningAlerts(transport, { baseUrl: BASE, owner: "foo", repo: "bar" }),
      ),
      safeFetchAlerts("dependabot", () =>
        fetchDependabotAlerts(transport, { baseUrl: BASE, owner: "foo", repo: "bar" }),
      ),
    ]);
    if (!c.ok) expect(c.missingScope).toBeUndefined();
    if (!s.ok) expect(s.missingScope).toBeUndefined();
    if (!d.ok) expect(d.missingScope).toBeUndefined();
  });

  it("falls back to a generic cause for unmapped HTTP statuses", async () => {
    const transport = makeTransport({
      [CODE_URL]: { status: 500, headers: {}, body: "" },
    });
    const result = await safeFetchAlerts("code-scanning", () =>
      fetchCodeScanningAlerts(transport, { baseUrl: BASE, owner: "foo", repo: "bar" }),
    );
    expect(result).toEqual({
      ok: false,
      cause: "Code Scanning unavailable: GitHub returned HTTP 500.",
      status: 500,
      code: "unknown",
    });
  });

  it("classifies non-HTTP throws (network errors) without a status", async () => {
    const transport = vi.fn(async (): Promise<FetchResult> => {
      throw new Error("ENOTFOUND api.github.com");
    });
    const result = await safeFetchAlerts("dependabot", () =>
      fetchDependabotAlerts(transport, { baseUrl: BASE, owner: "foo", repo: "bar" }),
    );
    expect(result).toEqual({
      ok: false,
      cause: "Dependabot alerts unavailable: ENOTFOUND api.github.com",
      code: "unknown",
    });
  });

  it("attaches status from AlertPaginationError", async () => {
    const err = new AlertPaginationError(410, "https://example/x");
    expect(err.status).toBe(410);
    expect(err.url).toBe("https://example/x");
    expect(err.message).toContain("410");
  });
});
