/**
 * WU-036: telemetry instrumentation in alerts-runtime.
 *
 * Architecture addendum (`.specifications/integration-plugins/architecture.md:949–950`)
 * pins the structured shape of these log lines:
 *
 * - One `alert-fetch` info per dispatched category, with duration and item count.
 * - One `warning-emitted` warn per category that returned a warning, with
 *   `sourceExternalId`, `category`, and `code` only. `cause` is NEVER included
 *   because it is a UI rendering string and may carry repo-derived text.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConfiguredSource, FetchInit, FetchResult } from "@roubo/plugin-sdk";
import { listIssues } from "../methods/list-issues.js";
import { resetAlertsRuntime } from "../alerts-runtime.js";
import { installMocks, okResponse, teardownMocks } from "./helpers.js";

interface InstalledMocks {
  mockHost: ReturnType<typeof installMocks>["mockHost"];
  mockOctokit: ReturnType<typeof installMocks>["mockOctokit"];
}

let mocks: InstalledMocks;

const CODE_URL =
  "https://api.github.com/repos/foo/bar/code-scanning/alerts?state=open&per_page=50&page=1";
const SECRET_URL =
  "https://api.github.com/repos/foo/bar/secret-scanning/alerts?state=open&per_page=50&page=1";
const DEP_URL = "https://api.github.com/repos/foo/bar/dependabot/alerts?state=open&per_page=50";

function queueHostResponses(map: Record<string, FetchResult>) {
  mocks.mockHost.fetch.mockImplementation(async (url: string, _init?: FetchInit) => {
    const r = map[url];
    if (!r) throw new Error(`unexpected url ${url}`);
    return r;
  });
}

function queueIssuesPage(items: unknown[] = []) {
  mocks.mockOctokit.request.mockResolvedValueOnce(okResponse(items));
  mocks.mockOctokit.graphql.mockResolvedValueOnce({ repository: {} });
}

function alertFetchCalls(): Array<Record<string, unknown>> {
  return mocks.mockHost.loggerInfo.mock.calls
    .map(([payload]) => payload as { message?: string; data?: Record<string, unknown> })
    .filter((p) => p.message === "alert-fetch")
    .map((p) => p.data as Record<string, unknown>);
}

function warningEmittedCalls(): Array<Record<string, unknown>> {
  return mocks.mockHost.loggerWarn.mock.calls
    .map(([payload]) => payload as { message?: string; data?: Record<string, unknown> })
    .filter((p) => p.message === "warning-emitted")
    .map((p) => p.data as Record<string, unknown>);
}

beforeEach(() => {
  resetAlertsRuntime();
  mocks = installMocks();
});

afterEach(() => {
  teardownMocks();
  resetAlertsRuntime();
});

describe("alerts-runtime telemetry (WU-036)", () => {
  it("emits no alert-fetch lines when no category booleans are enabled", async () => {
    queueIssuesPage();
    const sources: ConfiguredSource[] = [{ kind: "repo", externalId: "foo/bar" }];
    await listIssues({ sources, cursor: null, pageSize: 50 });
    expect(alertFetchCalls()).toHaveLength(0);
    expect(warningEmittedCalls()).toHaveLength(0);
  });

  it("emits exactly one alert-fetch info per enabled category on a healthy pull", async () => {
    queueIssuesPage();
    queueHostResponses({
      [CODE_URL]: {
        status: 200,
        headers: {},
        body: JSON.stringify([{ number: 1, html_url: "u", state: "open", created_at: "t" }]),
      },
      [SECRET_URL]: {
        status: 200,
        headers: {},
        body: JSON.stringify([
          { number: 2, html_url: "u", state: "open", created_at: "t" },
          { number: 3, html_url: "u", state: "open", created_at: "t" },
        ]),
      },
      [DEP_URL]: {
        status: 200,
        headers: {},
        body: JSON.stringify([{ number: 4, html_url: "u", state: "open", created_at: "t" }]),
      },
    });

    const sources: ConfiguredSource[] = [
      {
        kind: "repo",
        externalId: "foo/bar",
        includeCodeQLAlerts: true,
        includeSecretScanningAlerts: true,
        includeDependabotAlerts: true,
      },
    ];
    await listIssues({ sources, cursor: null, pageSize: 50 });

    const lines = alertFetchCalls();
    expect(lines).toHaveLength(3);

    const byCategory = new Map(lines.map((l) => [l.category as string, l]));
    for (const cat of ["code-scanning", "secret-scanning", "dependabot"] as const) {
      const line = byCategory.get(cat);
      if (!line) throw new Error(`missing alert-fetch line for ${cat}`);
      expect(line).toMatchObject({
        kind: "alert-fetch",
        category: cat,
        repoFullName: "foo/bar",
        page: 1,
        perPage: 50,
        status: "ok",
      });
      expect(typeof line.durationMs).toBe("number");
      expect(line.durationMs as number).toBeGreaterThanOrEqual(0);
      expect(typeof line.itemCount).toBe("number");
      expect(line.itemCount as number).toBeGreaterThan(0);
      expect(line.warningCode).toBeUndefined();
    }
    expect(warningEmittedCalls()).toHaveLength(0);
  });

  it("emits one warning-emitted warn per failed category and never includes `cause`", async () => {
    queueIssuesPage();
    queueHostResponses({
      // Code-scanning 404 -> warning, others succeed.
      [CODE_URL]: { status: 404, headers: {}, body: JSON.stringify({ message: "Not Found" }) },
      [SECRET_URL]: {
        status: 200,
        headers: {},
        body: JSON.stringify([{ number: 9, html_url: "u", state: "open", created_at: "t" }]),
      },
      [DEP_URL]: {
        status: 200,
        headers: {},
        body: JSON.stringify([{ number: 10, html_url: "u", state: "open", created_at: "t" }]),
      },
    });

    const sources: ConfiguredSource[] = [
      {
        kind: "repo",
        externalId: "foo/bar",
        includeCodeQLAlerts: true,
        includeSecretScanningAlerts: true,
        includeDependabotAlerts: true,
      },
    ];
    await listIssues({ sources, cursor: null, pageSize: 50 });

    const warnings = warningEmittedCalls();
    expect(warnings).toHaveLength(1);
    const w = warnings[0];
    if (!w) throw new Error("expected one warning-emitted line");
    expect(w).toEqual({
      kind: "warning-emitted",
      sourceExternalId: "foo/bar",
      category: "code-scanning",
      code: "not-found",
    });
    expect(w).not.toHaveProperty("cause");
    expect(w).not.toHaveProperty("detail");
    expect(w).not.toHaveProperty("missingScope");

    // The failed category still emits an alert-fetch line, marked as warning.
    const codeFetchLine = alertFetchCalls().find((l) => l.category === "code-scanning");
    expect(codeFetchLine).toMatchObject({
      kind: "alert-fetch",
      category: "code-scanning",
      status: "warning",
      warningCode: "not-found",
      itemCount: 0,
    });
  });

  it("includes the configured source externalId on warning-emitted lines", async () => {
    queueIssuesPage();
    queueHostResponses({
      [DEP_URL]: { status: 404, headers: {}, body: JSON.stringify({ message: "Not Found" }) },
    });

    const sources: ConfiguredSource[] = [
      {
        kind: "repo",
        externalId: "foo/bar",
        includeDependabotAlerts: true,
      },
    ];
    await listIssues({ sources, cursor: null, pageSize: 50 });

    const warnings = warningEmittedCalls();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      sourceExternalId: "foo/bar",
      category: "dependabot",
    });
  });
});
