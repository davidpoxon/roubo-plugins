/**
 * WU-030: listIssues alert-merge behaviour.
 *
 * Covers:
 * - All booleans off → no alert fetches dispatched
 * - All booleans on, healthy → mapped alerts merged in fixed order (issues →
 *   code-scanning → secret-scanning → dependabot), no warnings
 * - Code-scanning 404 → warning emitted, other two categories proceed (AC #8)
 * - Page > 1 → no alert fetches even with booleans on
 * - Project source spanning two repos → warnings deduped by (category, cause)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConfiguredSource, FetchResult } from "@roubo/plugin-sdk";
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
  mocks.mockHost.fetch.mockImplementation(async (url: string) => {
    const r = map[url];
    if (!r) throw new Error(`unexpected url ${url}`);
    return r;
  });
}

beforeEach(() => {
  resetAlertsRuntime();
  mocks = installMocks();
});

afterEach(() => {
  teardownMocks();
  resetAlertsRuntime();
});

function queueIssuesPage(items: unknown[] = []) {
  mocks.mockOctokit.request.mockResolvedValueOnce(okResponse(items));
  mocks.mockOctokit.graphql.mockResolvedValueOnce({ repository: {} });
}

describe("listIssues + alerts (WU-030)", () => {
  it("does not dispatch alert fetches when no booleans are enabled", async () => {
    queueIssuesPage();
    const sources: ConfiguredSource[] = [{ kind: "repo", externalId: "foo/bar" }];
    const result = await listIssues({ sources, cursor: null, pageSize: 50 });
    expect(result.items).toEqual([]);
    expect(result.warnings).toBeUndefined();
    expect(mocks.mockHost.fetch).not.toHaveBeenCalled();
  });

  it("merges all three categories in fixed order with no warnings when healthy", async () => {
    queueIssuesPage();
    queueHostResponses({
      [CODE_URL]: {
        status: 200,
        headers: {},
        body: JSON.stringify([{ number: 7, html_url: "code-url", state: "open", created_at: "t" }]),
      },
      [SECRET_URL]: {
        status: 200,
        headers: {},
        body: JSON.stringify([
          { number: 9, html_url: "secret-url", state: "open", created_at: "t" },
        ]),
      },
      [DEP_URL]: {
        status: 200,
        headers: {},
        body: JSON.stringify([{ number: 3, html_url: "dep-url", state: "open", created_at: "t" }]),
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
    const result = await listIssues({ sources, cursor: null, pageSize: 50 });

    expect(result.warnings).toBeUndefined();
    expect(result.items.map((i) => i.externalId)).toEqual([
      "foo/bar#code-scanning-7",
      "foo/bar#secret-scanning-9",
      "foo/bar#dependabot-3",
    ]);
    expect(result.items.map((i) => i.issueType)).toEqual([
      "security-code-scanning",
      "security-secret-scanning",
      "security-dependabot",
    ]);
  });

  it("flags missing security_events scope via detail.missingScope on 401 (WU-039)", async () => {
    queueIssuesPage();
    queueHostResponses({
      [CODE_URL]: { status: 401, headers: {}, body: "" },
      [SECRET_URL]: { status: 200, headers: {}, body: JSON.stringify([]) },
      [DEP_URL]: { status: 200, headers: {}, body: JSON.stringify([]) },
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
    const result = await listIssues({ sources, cursor: null, pageSize: 50 });

    expect(result.warnings).toEqual([
      {
        category: "code-scanning",
        sourceExternalId: "foo/bar",
        cause: "Code Scanning unavailable: missing security_events scope on the GitHub token.",
        code: "missing-scope",
        detail: { status: 401, missingScope: "security_events" },
      },
    ]);
  });

  it("emits a warning for the failing category and continues fetching the others (AC #5, #8)", async () => {
    queueIssuesPage();
    queueHostResponses({
      [CODE_URL]: { status: 404, headers: {}, body: "" },
      [SECRET_URL]: { status: 200, headers: {}, body: JSON.stringify([]) },
      [DEP_URL]: {
        status: 200,
        headers: {},
        body: JSON.stringify([{ number: 1, html_url: "u", state: "open", created_at: "t" }]),
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
    const result = await listIssues({ sources, cursor: null, pageSize: 50 });

    expect(result.items.map((i) => i.externalId)).toEqual(["foo/bar#dependabot-1"]);
    expect(result.warnings).toEqual([
      {
        category: "code-scanning",
        sourceExternalId: "foo/bar",
        cause: "Code Scanning unavailable: GHAS not enabled on this repo.",
        code: "not-found",
        detail: { status: 404 },
      },
    ]);
  });

  it("does not dispatch alert fetches on page 2+", async () => {
    queueIssuesPage();
    const sources: ConfiguredSource[] = [
      {
        kind: "repo",
        externalId: "foo/bar",
        includeCodeQLAlerts: true,
        includeSecretScanningAlerts: true,
        includeDependabotAlerts: true,
      },
    ];
    await listIssues({ sources, cursor: "2", pageSize: 50 });
    expect(mocks.mockHost.fetch).not.toHaveBeenCalled();
  });

  it("fans alerts out across every repo the project spans, even repos that first appear past the page-1 issue slice", async () => {
    // Project has two items in two different repos. With pageSize 1 the
    // page-1 issue slice only includes the item in repo1, but alerts must
    // still fan out to both repo1 and repo2 since alerts only fire on page 1.
    mocks.mockOctokit.graphql.mockResolvedValueOnce({
      organization: {
        projectV2: {
          title: "P",
          items: {
            nodes: [
              {
                content: {
                  __typename: "Issue",
                  number: 1,
                  title: "a",
                  body: null,
                  state: "open",
                  repository: { nameWithOwner: "foo/repo1" },
                  labels: { nodes: [] },
                  assignees: { nodes: [] },
                  milestone: null,
                  issueType: null,
                  createdAt: "x",
                  updatedAt: "x",
                  comments: { totalCount: 0 },
                  url: "u1",
                },
                fieldValueByName: null,
              },
              {
                content: {
                  __typename: "Issue",
                  number: 2,
                  title: "b",
                  body: null,
                  state: "open",
                  repository: { nameWithOwner: "foo/repo2" },
                  labels: { nodes: [] },
                  assignees: { nodes: [] },
                  milestone: null,
                  issueType: null,
                  createdAt: "x",
                  updatedAt: "x",
                  comments: { totalCount: 0 },
                  url: "u2",
                },
                fieldValueByName: null,
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });
    // Only the page-1 slice (repo1) drives a blocking-relationships call.
    mocks.mockOctokit.graphql.mockResolvedValueOnce({ repository: {} });

    const CODE_URL_1 =
      "https://api.github.com/repos/foo/repo1/code-scanning/alerts?state=open&per_page=50&page=1";
    const CODE_URL_2 =
      "https://api.github.com/repos/foo/repo2/code-scanning/alerts?state=open&per_page=50&page=1";

    const seenUrls: string[] = [];
    mocks.mockHost.fetch.mockImplementation(async (url: string) => {
      seenUrls.push(url);
      if (url === CODE_URL_1 || url === CODE_URL_2) {
        return { status: 200, headers: {}, body: JSON.stringify([]) };
      }
      throw new Error(`unexpected url ${url}`);
    });

    const sources: ConfiguredSource[] = [
      {
        kind: "project",
        externalId: "foo/#1",
        includeCodeQLAlerts: true,
      },
    ];
    await listIssues({ sources, cursor: null, pageSize: 1 });

    expect(seenUrls).toContain(CODE_URL_1);
    expect(seenUrls).toContain(CODE_URL_2);
  });

  it("keeps a repo's alerts even when all its board issues are status-excluded (issue #399)", async () => {
    // The board's only issue is in an excluded Status column, so no issue
    // reaches the cut list. Alerts fan out over the pre-exclusion repo set, so
    // the repo's code-scanning alert must still surface.
    mocks.mockOctokit.graphql.mockResolvedValueOnce({
      organization: {
        projectV2: {
          title: "P",
          items: {
            nodes: [
              {
                content: {
                  __typename: "Issue",
                  number: 1,
                  title: "done item",
                  body: null,
                  state: "open",
                  repository: { nameWithOwner: "foo/bar" },
                  labels: { nodes: [] },
                  assignees: { nodes: [] },
                  milestone: null,
                  issueType: null,
                  createdAt: "x",
                  updatedAt: "x",
                  comments: { totalCount: 0 },
                  url: "u1",
                },
                fieldValueByName: { name: "Done" },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });
    // No blocking graphql call: the only issue is excluded, so the slice is empty.

    queueHostResponses({
      [CODE_URL]: {
        status: 200,
        headers: {},
        body: JSON.stringify([{ number: 7, html_url: "code-url", state: "open", created_at: "t" }]),
      },
    });

    const sources: ConfiguredSource[] = [
      { kind: "project", externalId: "foo/#1", includeCodeQLAlerts: true },
    ];
    const result = await listIssues({
      sources,
      cursor: null,
      pageSize: 50,
      excludedStatuses: ["Done"],
    });

    expect(mocks.mockHost.fetch).toHaveBeenCalled();
    expect(result.items.map((i) => i.externalId)).toEqual(["foo/bar#code-scanning-7"]);
  });

  it("dedupes project warnings by (category, cause) across repos in the project", async () => {
    // Two repos sharing the same 404 cause should produce a single warning.
    mocks.mockOctokit.graphql.mockResolvedValueOnce({
      organization: {
        projectV2: {
          title: "P",
          items: {
            nodes: [
              {
                content: {
                  __typename: "Issue",
                  number: 1,
                  title: "a",
                  body: null,
                  state: "open",
                  repository: { nameWithOwner: "foo/repo1" },
                  labels: { nodes: [] },
                  assignees: { nodes: [] },
                  milestone: null,
                  issueType: null,
                  createdAt: "x",
                  updatedAt: "x",
                  comments: { totalCount: 0 },
                  url: "u1",
                },
                fieldValueByName: null,
              },
              {
                content: {
                  __typename: "Issue",
                  number: 2,
                  title: "b",
                  body: null,
                  state: "open",
                  repository: { nameWithOwner: "foo/repo2" },
                  labels: { nodes: [] },
                  assignees: { nodes: [] },
                  milestone: null,
                  issueType: null,
                  createdAt: "x",
                  updatedAt: "x",
                  comments: { totalCount: 0 },
                  url: "u2",
                },
                fieldValueByName: null,
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });
    // Two per-repo blocking-relationship calls (one per repo).
    mocks.mockOctokit.graphql.mockResolvedValueOnce({ repository: {} });
    mocks.mockOctokit.graphql.mockResolvedValueOnce({ repository: {} });

    const CODE_URL_1 =
      "https://api.github.com/repos/foo/repo1/code-scanning/alerts?state=open&per_page=50&page=1";
    const CODE_URL_2 =
      "https://api.github.com/repos/foo/repo2/code-scanning/alerts?state=open&per_page=50&page=1";

    mocks.mockHost.fetch.mockImplementation(async (url: string) => {
      if (url === CODE_URL_1 || url === CODE_URL_2) {
        return { status: 404, headers: {}, body: "" };
      }
      throw new Error(`unexpected url ${url}`);
    });

    const sources: ConfiguredSource[] = [
      {
        kind: "project",
        externalId: "foo/#1",
        includeCodeQLAlerts: true,
      },
    ];
    const result = await listIssues({ sources, cursor: null, pageSize: 50 });

    expect(result.warnings).toEqual([
      {
        category: "code-scanning",
        sourceExternalId: "foo/#1",
        cause: "Code Scanning unavailable: GHAS not enabled on this repo.",
        code: "not-found",
        detail: { status: 404 },
      },
    ]);
  });
});
