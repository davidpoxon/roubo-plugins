import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConfiguredSource } from "@roubo/plugin-sdk";
import { decodeCompositeCursor } from "@roubo/shared-github";
import { listIssues } from "../methods/list-issues.js";
import { installMocks, okResponse, teardownMocks } from "./helpers.js";

const REPO_SOURCES: ConfiguredSource[] = [{ kind: "repo", externalId: "foo/bar" }];

describe("listIssues", () => {
  let mocks: ReturnType<typeof installMocks>;

  beforeEach(() => {
    mocks = installMocks();
  });

  afterEach(() => {
    teardownMocks();
  });

  it("throws a clear error if sources is missing or empty", async () => {
    await expect(listIssues({ sources: [], cursor: null, pageSize: 50 })).rejects.toThrow(
      /sources is required/,
    );
  });

  it("queries the configured repo source and enriches with blocking relationships", async () => {
    const rawIssues = [
      {
        number: 10,
        title: "first",
        body: null,
        state: "open",
        labels: [],
        created_at: "x",
        updated_at: "x",
        comments: 0,
        html_url: "https://github.com/foo/bar/issues/10",
      },
      {
        number: 11,
        title: "second",
        body: null,
        state: "open",
        labels: [],
        created_at: "x",
        updated_at: "x",
        comments: 0,
        html_url: "https://github.com/foo/bar/issues/11",
      },
    ];

    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse(rawIssues));
    mocks.mockOctokit.graphql.mockResolvedValueOnce({
      repository: {
        issue_10: {
          blockedBy: {
            nodes: [{ number: 11, title: "second", state: "OPEN" }],
          },
          blocking: { nodes: [], pageInfo: { hasNextPage: false } },
        },
        issue_11: {
          blockedBy: { nodes: [] },
          blocking: { nodes: [], pageInfo: { hasNextPage: false } },
        },
      },
    });

    const result = await listIssues({ sources: REPO_SOURCES, cursor: null, pageSize: 50 });
    expect(result.items).toHaveLength(2);
    expect(result.items[0].externalId).toBe("foo/bar#10");
    expect(result.items[0].blockedBy).toEqual(["foo/bar#11"]);
    expect(result.items[0].blocks).toEqual([]);
    expect(result.items[1].externalId).toBe("foo/bar#11");
    expect(result.nextCursor).toBeNull();
  });

  it("returns a next cursor when the page is full", async () => {
    const fullPage = Array.from({ length: 2 }, (_, i) => ({
      number: i + 1,
      title: `t${i}`,
      body: null,
      state: "open",
      labels: [],
      created_at: "x",
      updated_at: "x",
      comments: 0,
      html_url: "u",
    }));
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse(fullPage));
    mocks.mockOctokit.graphql.mockResolvedValueOnce({
      repository: {
        issue_1: {
          blockedBy: { nodes: [] },
          blocking: { nodes: [], pageInfo: { hasNextPage: false } },
        },
        issue_2: {
          blockedBy: { nodes: [] },
          blocking: { nodes: [], pageInfo: { hasNextPage: false } },
        },
      },
    });

    const result = await listIssues({ sources: REPO_SOURCES, cursor: null, pageSize: 2 });
    expect(result.items).toHaveLength(2);
    // nextCursor is an opaque composite cursor carrying each source's own next
    // page; the single repo source advances to page 2.
    expect(decodeCompositeCursor(result.nextCursor as string)).toEqual({ "foo/bar": "2" });
  });

  it("passes labels filter through to the GitHub request", async () => {
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse([]));
    mocks.mockOctokit.graphql.mockResolvedValueOnce({ repository: {} });

    await listIssues({
      sources: REPO_SOURCES,
      cursor: null,
      pageSize: 5,
      filters: { labels: ["bug", "p1"] },
    });

    const params = mocks.mockOctokit.request.mock.calls[0][1] as Record<string, unknown>;
    expect(params.labels).toBe("bug,p1");
  });

  it("applies the host sortBy/sortDir source-side via the REST sort/direction params (CLI-FR-010)", async () => {
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse([]));
    mocks.mockOctokit.graphql.mockResolvedValueOnce({ repository: {} });

    await listIssues({
      sources: REPO_SOURCES,
      cursor: null,
      pageSize: 5,
      sortBy: "created",
      sortDir: "asc",
    });

    const params = mocks.mockOctokit.request.mock.calls[0][1] as Record<string, unknown>;
    expect(params.sort).toBe("created");
    expect(params.direction).toBe("asc");
  });

  it("falls back to the default updated/desc ordering when no sort is requested", async () => {
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse([]));
    mocks.mockOctokit.graphql.mockResolvedValueOnce({ repository: {} });

    await listIssues({ sources: REPO_SOURCES, cursor: null, pageSize: 5 });

    const params = mocks.mockOctokit.request.mock.calls[0][1] as Record<string, unknown>;
    expect(params.sort).toBe("updated");
    expect(params.direction).toBe("desc");
  });

  it("ignores an unrecognised sortBy field (falls back to the default ordering)", async () => {
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse([]));
    mocks.mockOctokit.graphql.mockResolvedValueOnce({ repository: {} });

    await listIssues({
      sources: REPO_SOURCES,
      cursor: null,
      pageSize: 5,
      sortBy: "nonsense",
      sortDir: "asc",
    });

    const params = mocks.mockOctokit.request.mock.calls[0][1] as Record<string, unknown>;
    expect(params.sort).toBe("updated");
    expect(params.direction).toBe("desc");
  });

  it("reports hasNextPage when the unfiltered API response is a full page, even if PRs were filtered out", async () => {
    // Regression: `/repos/{owner}/{repo}/issues` returns issues and PRs
    // interleaved. Computing hasNextPage from the post-filter item count
    // would short-circuit pagination as soon as a page contained any PR.
    const mixedFullPage = [
      {
        number: 1,
        title: "issue",
        body: null,
        state: "open",
        labels: [],
        created_at: "x",
        updated_at: "x",
        comments: 0,
        html_url: "u",
      },
      {
        number: 2,
        title: "pr",
        body: null,
        state: "open",
        labels: [],
        created_at: "x",
        updated_at: "x",
        comments: 0,
        html_url: "u",
        pull_request: { url: "https://api.github.com/repos/foo/bar/pulls/2" },
      },
    ];
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse(mixedFullPage));
    mocks.mockOctokit.graphql.mockResolvedValueOnce({
      repository: {
        issue_1: {
          blockedBy: { nodes: [] },
          blocking: { nodes: [], pageInfo: { hasNextPage: false } },
        },
      },
    });

    const result = await listIssues({ sources: REPO_SOURCES, cursor: null, pageSize: 2 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe("issue");
    expect(decodeCompositeCursor(result.nextCursor as string)).toEqual({ "foo/bar": "2" });
  });

  it("enriches project-sourced issues with per-repo blocking relationships", async () => {
    const PROJECT_SOURCES: ConfiguredSource[] = [{ kind: "project", externalId: "davidpoxon/#1" }];

    // First GraphQL call: fetchProjectItems → organization(login).projectV2
    mocks.mockOctokit.graphql.mockResolvedValueOnce({
      organization: {
        projectV2: {
          title: "Roadmap",
          items: {
            nodes: [
              {
                content: {
                  __typename: "Issue",
                  number: 106,
                  title: "WU-030",
                  body: null,
                  state: "open",
                  repository: { nameWithOwner: "davidpoxon/roubo" },
                  labels: { nodes: [] },
                  assignees: { nodes: [] },
                  milestone: null,
                  issueType: null,
                  createdAt: "x",
                  updatedAt: "x",
                  comments: { totalCount: 0 },
                  url: "https://github.com/davidpoxon/roubo/issues/106",
                },
                fieldValueByName: null,
              },
              {
                content: {
                  __typename: "Issue",
                  number: 5,
                  title: "Other",
                  body: null,
                  state: "open",
                  repository: { nameWithOwner: "davidpoxon/other" },
                  labels: { nodes: [] },
                  assignees: { nodes: [] },
                  milestone: null,
                  issueType: null,
                  createdAt: "x",
                  updatedAt: "x",
                  comments: { totalCount: 0 },
                  url: "https://github.com/davidpoxon/other/issues/5",
                },
                fieldValueByName: null,
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });

    // Two blocking-relationship GraphQL calls, one per repo. Order matches
    // insertion order of the per-repo Map (davidpoxon/roubo, then
    // davidpoxon/other).
    mocks.mockOctokit.graphql.mockResolvedValueOnce({
      repository: {
        issue_106: {
          blockedBy: {
            nodes: [
              { number: 104, title: "WU-028", state: "OPEN" },
              { number: 105, title: "WU-029", state: "OPEN" },
            ],
          },
          blocking: { nodes: [], pageInfo: { hasNextPage: false } },
        },
      },
    });
    mocks.mockOctokit.graphql.mockResolvedValueOnce({
      repository: {
        issue_5: {
          blockedBy: { nodes: [] },
          blocking: {
            nodes: [{ number: 9, title: "Downstream", state: "OPEN" }],
            pageInfo: { hasNextPage: false },
          },
        },
      },
    });

    const result = await listIssues({
      sources: PROJECT_SOURCES,
      cursor: null,
      pageSize: 50,
    });

    expect(result.items).toHaveLength(2);
    const item106 = result.items.find((i) => i.externalId === "davidpoxon/roubo#106");
    const item5 = result.items.find((i) => i.externalId === "davidpoxon/other#5");
    expect(item106?.blockedBy).toEqual(["davidpoxon/roubo#104", "davidpoxon/roubo#105"]);
    expect(item106?.blocks).toEqual([]);
    expect(item5?.blockedBy).toEqual([]);
    expect(item5?.blocks).toEqual(["davidpoxon/other#9"]);

    // Three GraphQL calls total: 1 project items + 1 per distinct repo.
    expect(mocks.mockOctokit.graphql).toHaveBeenCalledTimes(3);
  });

  it("uses search API when filters.search is set", async () => {
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse({ items: [] }));
    mocks.mockOctokit.graphql.mockResolvedValueOnce({ repository: {} });

    await listIssues({
      sources: REPO_SOURCES,
      cursor: null,
      pageSize: 5,
      filters: { search: "label:bug" },
    });

    const route = mocks.mockOctokit.request.mock.calls[0][0] as string;
    expect(route).toBe("GET /search/issues");
    const params = mocks.mockOctokit.request.mock.calls[0][1] as Record<string, unknown>;
    expect(params.q).toContain("repo:foo/bar");
    expect(params.q).toContain("is:issue is:open");
    expect(params.q).toContain("label:bug");
  });
});
