/**
 * Project-board scoping for `listIssues` (GHE mirror of the github-com suite).
 *
 * A GitHub Project (v2) board can carry issues from any repo and in any state.
 * `listFromProject` keeps only OPEN issues whose repo is one of the project's
 * configured Repository sources, falling back to "open only, any repo" when the
 * project has no repo sources to scope against. The GHE project path does not
 * enrich items with blocking relationships, so no blocking graphql is issued.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConfiguredSource } from "@roubo/plugin-sdk";
import { decodeCompositeCursor } from "@roubo/shared-github";
import { listIssues } from "../methods/list-issues.js";
import { installMocks, okResponse, teardownMocks } from "./helpers.js";

function projectItemNode(opts: {
  number: number;
  repo: string;
  state: "open" | "closed";
  status?: string;
}) {
  return {
    content: {
      __typename: "Issue",
      number: opts.number,
      title: `issue ${opts.number}`,
      body: null,
      state: opts.state,
      repository: { nameWithOwner: opts.repo },
      labels: { nodes: [] },
      assignees: { nodes: [] },
      milestone: null,
      issueType: null,
      createdAt: "x",
      updatedAt: "x",
      comments: { totalCount: 0 },
      url: `https://example.com/${opts.repo}/issues/${opts.number}`,
    },
    fieldValueByName: opts.status === undefined ? null : { name: opts.status },
  };
}

function projectItemsResponse(nodes: unknown[], opts: { hasNextPage?: boolean } = {}) {
  return {
    organization: {
      projectV2: {
        title: "Board",
        items: {
          nodes,
          pageInfo: { hasNextPage: opts.hasNextPage ?? false, endCursor: null },
        },
      },
    },
  };
}

describe("listIssues project-board scoping", () => {
  let mocks: ReturnType<typeof installMocks>;

  beforeEach(() => {
    mocks = installMocks();
  });

  afterEach(() => {
    teardownMocks();
  });

  it("keeps only open issues from the project's configured repos, dropping closed and foreign-repo board items", async () => {
    const sources: ConfiguredSource[] = [
      { kind: "repo", externalId: "acme/web" },
      { kind: "project", externalId: "acme/#1" },
    ];

    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse([])); // acme/web issues (empty)
    mocks.mockOctokit.graphql.mockResolvedValueOnce(
      projectItemsResponse([
        projectItemNode({ number: 100, repo: "acme/web", state: "open" }),
        projectItemNode({ number: 101, repo: "acme/web", state: "closed" }),
        projectItemNode({ number: 200, repo: "other/foreign", state: "open" }),
      ]),
    );

    const result = await listIssues({ sources, cursor: null, pageSize: 50 });

    expect(result.items.map((i) => i.externalId)).toEqual(["acme/web#100"]);
    expect(result.nextCursor).toBeNull();
  });

  it("drops closed board issues even when the project has no repo sources to scope against", async () => {
    const sources: ConfiguredSource[] = [{ kind: "project", externalId: "acme/#1" }];

    mocks.mockOctokit.graphql.mockResolvedValueOnce(
      projectItemsResponse([
        projectItemNode({ number: 1, repo: "acme/svc", state: "open" }),
        projectItemNode({ number: 2, repo: "acme/svc", state: "closed" }),
      ]),
    );

    const result = await listIssues({ sources, cursor: null, pageSize: 50 });

    expect(result.items.map((i) => i.externalId)).toEqual(["acme/svc#1"]);
    expect(result.nextCursor).toBeNull();
  });

  it("paginates over the filtered issue list, not the raw board items", async () => {
    const sources: ConfiguredSource[] = [
      { kind: "repo", externalId: "acme/web" },
      { kind: "project", externalId: "acme/#1" },
    ];

    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse([])); // acme/web issues (empty)
    mocks.mockOctokit.graphql.mockResolvedValueOnce(
      projectItemsResponse([
        projectItemNode({ number: 100, repo: "acme/web", state: "open" }),
        projectItemNode({ number: 101, repo: "acme/web", state: "closed" }),
        projectItemNode({ number: 102, repo: "acme/web", state: "open" }),
      ]),
    );

    const page1 = await listIssues({ sources, cursor: null, pageSize: 1 });
    expect(page1.items.map((i) => i.externalId)).toEqual(["acme/web#100"]);
    expect(decodeCompositeCursor(page1.nextCursor as string)).toEqual({ "acme/#1": "2" });

    // Page 2: project items served from cache, no blocking enrichment on GHE, so
    // no further graphql is issued.
    const page2 = await listIssues({ sources, cursor: page1.nextCursor, pageSize: 1 });

    expect(page2.items.map((i) => i.externalId)).toEqual(["acme/web#102"]);
    expect(page2.nextCursor).toBeNull();
  });

  // Issue #399: server-side status exclusion for the github family, reusing the
  // shared `isStatusExcluded` helper. The board item's Projects v2 "Status"
  // column is matched case-insensitively against the resolved excludedStatuses.
  it("excludes board items whose Status column is in excludedStatuses, matching case-insensitively", async () => {
    const sources: ConfiguredSource[] = [{ kind: "project", externalId: "acme/#1" }];

    mocks.mockOctokit.graphql.mockResolvedValueOnce(
      projectItemsResponse([
        projectItemNode({ number: 1, repo: "acme/svc", state: "open", status: "In progress" }),
        projectItemNode({ number: 2, repo: "acme/svc", state: "open", status: "in REVIEW" }),
        projectItemNode({ number: 3, repo: "acme/svc", state: "open", status: "Done" }),
        projectItemNode({ number: 4, repo: "acme/svc", state: "open" }),
      ]),
    );

    const result = await listIssues({
      sources,
      cursor: null,
      pageSize: 50,
      excludedStatuses: ["In review", "Done"],
    });

    // #2 ("in REVIEW") and #3 ("Done") are excluded; the null-status #4 is kept.
    expect(result.items.map((i) => i.externalId)).toEqual(["acme/svc#1", "acme/svc#4"]);
    expect(result.nextCursor).toBeNull();
  });

  it("never lets an excluded board item occupy a result-page slot", async () => {
    const sources: ConfiguredSource[] = [{ kind: "project", externalId: "acme/#1" }];

    // An excluded item is wedged between two visible ones; with pageSize 1 it
    // must not consume the single slot.
    mocks.mockOctokit.graphql.mockResolvedValueOnce(
      projectItemsResponse([
        projectItemNode({ number: 10, repo: "acme/svc", state: "open" }),
        projectItemNode({ number: 11, repo: "acme/svc", state: "open", status: "Done" }),
        projectItemNode({ number: 12, repo: "acme/svc", state: "open" }),
      ]),
    );

    const page1 = await listIssues({
      sources,
      cursor: null,
      pageSize: 1,
      excludedStatuses: ["Done"],
    });
    expect(page1.items.map((i) => i.externalId)).toEqual(["acme/svc#10"]);
    expect(decodeCompositeCursor(page1.nextCursor as string)).toEqual({ "acme/#1": "2" });

    // Page 2 is served from cache; the excluded #11 left no gap, so #12 is next.
    const page2 = await listIssues({
      sources,
      cursor: page1.nextCursor,
      pageSize: 1,
      excludedStatuses: ["Done"],
    });
    expect(page2.items.map((i) => i.externalId)).toEqual(["acme/svc#12"]);
    expect(page2.nextCursor).toBeNull();
  });
});
