/**
 * Project-board scoping for `listIssues`.
 *
 * A GitHub Project (v2) board can carry issues from any repo (even cross-org)
 * and in any state. Two defects surfaced once multi-source aggregation started
 * actually querying Project sources:
 * - closed board issues reached the cut list (the repo path filters state:open,
 *   the project path did not)
 * - issues from repos outside the project's own configured Repository sources
 *   reached the cut list (e.g. a foreign repo's issue parked on an org board)
 *
 * `listFromProject` now keeps only OPEN issues whose repo is one of the
 * project's configured Repository sources, falling back to "open only, any
 * repo" when the project has no repo sources to scope against.
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
      url: `https://github.com/${opts.repo}/issues/${opts.number}`,
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

function noBlocking(issueNumber: number) {
  return {
    repository: {
      [`issue_${issueNumber}`]: {
        blockedBy: { nodes: [] },
        blocking: { nodes: [], pageInfo: { hasNextPage: false } },
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

    // acme/web has no issues of its own; everything comes off the board.
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse([]));
    // Board carries: an open configured-repo issue (keep), a closed
    // configured-repo issue (drop: state), and an open foreign-repo issue (drop:
    // scope) such as one parked on an org board from another project.
    mocks.mockOctokit.graphql.mockResolvedValueOnce(
      projectItemsResponse([
        projectItemNode({ number: 100, repo: "acme/web", state: "open" }),
        projectItemNode({ number: 101, repo: "acme/web", state: "closed" }),
        projectItemNode({ number: 200, repo: "other/foreign", state: "open" }),
      ]),
    );
    // Blocking lookup for the single surviving issue's repo.
    mocks.mockOctokit.graphql.mockResolvedValueOnce(noBlocking(100));

    const result = await listIssues({ sources, cursor: null, pageSize: 50 });

    expect(result.items.map((i) => i.externalId)).toEqual(["acme/web#100"]);
    expect(result.nextCursor).toBeNull();
  });

  it("drops closed board issues even when the project has no repo sources to scope against", async () => {
    const sources: ConfiguredSource[] = [{ kind: "project", externalId: "davidpoxon/#1" }];

    mocks.mockOctokit.graphql.mockResolvedValueOnce(
      projectItemsResponse([
        projectItemNode({ number: 1, repo: "davidpoxon/roubo", state: "open" }),
        projectItemNode({ number: 2, repo: "davidpoxon/roubo", state: "closed" }),
      ]),
    );
    mocks.mockOctokit.graphql.mockResolvedValueOnce(noBlocking(1));

    const result = await listIssues({ sources, cursor: null, pageSize: 50 });

    expect(result.items.map((i) => i.externalId)).toEqual(["davidpoxon/roubo#1"]);
    expect(result.nextCursor).toBeNull();
  });

  it("paginates over the filtered issue list, not the raw board items", async () => {
    const sources: ConfiguredSource[] = [
      { kind: "repo", externalId: "acme/web" },
      { kind: "project", externalId: "acme/#1" },
    ];

    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse([])); // acme/web issues (empty)
    // Board: two open configured-repo issues with a closed one wedged between
    // them. With pageSize 1 the closed item must not consume a page slot.
    mocks.mockOctokit.graphql.mockResolvedValueOnce(
      projectItemsResponse([
        projectItemNode({ number: 100, repo: "acme/web", state: "open" }),
        projectItemNode({ number: 101, repo: "acme/web", state: "closed" }),
        projectItemNode({ number: 102, repo: "acme/web", state: "open" }),
      ]),
    );
    mocks.mockOctokit.graphql.mockResolvedValueOnce(noBlocking(100)); // page 1 blocking

    const page1 = await listIssues({ sources, cursor: null, pageSize: 1 });
    expect(page1.items.map((i) => i.externalId)).toEqual(["acme/web#100"]);
    // Only the project source carries forward; the empty repo source is gone.
    expect(decodeCompositeCursor(page1.nextCursor as string)).toEqual({ "acme/#1": "2" });

    // Page 2: project items are served from cache (no projectItems graphql), so
    // only the second open issue's blocking lookup is queued.
    mocks.mockOctokit.graphql.mockResolvedValueOnce(noBlocking(102));
    const page2 = await listIssues({ sources, cursor: page1.nextCursor, pageSize: 1 });

    expect(page2.items.map((i) => i.externalId)).toEqual(["acme/web#102"]);
    expect(page2.nextCursor).toBeNull();
  });

  // Issue #399: server-side status exclusion for the github family. The board
  // item's Projects v2 "Status" column is matched (case-insensitively) against
  // the host-resolved excludedStatuses list inside the plugin.
  it("excludes board items whose Status column is in excludedStatuses, matching case-insensitively", async () => {
    const sources: ConfiguredSource[] = [{ kind: "project", externalId: "davidpoxon/#1" }];

    mocks.mockOctokit.graphql.mockResolvedValueOnce(
      projectItemsResponse([
        projectItemNode({
          number: 1,
          repo: "davidpoxon/roubo",
          state: "open",
          status: "In progress",
        }),
        projectItemNode({
          number: 2,
          repo: "davidpoxon/roubo",
          state: "open",
          status: "in REVIEW",
        }),
        projectItemNode({ number: 3, repo: "davidpoxon/roubo", state: "open", status: "Done" }),
        projectItemNode({ number: 4, repo: "davidpoxon/roubo", state: "open" }),
      ]),
    );
    // Blocking lookup covers only the two surviving issues (#1, #4) in one repo.
    mocks.mockOctokit.graphql.mockResolvedValueOnce({
      repository: {
        issue_1: {
          blockedBy: { nodes: [] },
          blocking: { nodes: [], pageInfo: { hasNextPage: false } },
        },
        issue_4: {
          blockedBy: { nodes: [] },
          blocking: { nodes: [], pageInfo: { hasNextPage: false } },
        },
      },
    });

    const result = await listIssues({
      sources,
      cursor: null,
      pageSize: 50,
      excludedStatuses: ["In review", "Done"],
    });

    // #2 ("in REVIEW") and #3 ("Done") are excluded; the null-status #4 is kept.
    expect(result.items.map((i) => i.externalId)).toEqual([
      "davidpoxon/roubo#1",
      "davidpoxon/roubo#4",
    ]);
    expect(result.nextCursor).toBeNull();
  });

  it("never lets an excluded board item occupy a result-page slot", async () => {
    const sources: ConfiguredSource[] = [{ kind: "project", externalId: "davidpoxon/#1" }];

    // An excluded item is wedged between two visible ones; with pageSize 1 it
    // must not consume the single slot.
    mocks.mockOctokit.graphql.mockResolvedValueOnce(
      projectItemsResponse([
        projectItemNode({ number: 10, repo: "davidpoxon/roubo", state: "open" }),
        projectItemNode({ number: 11, repo: "davidpoxon/roubo", state: "open", status: "Done" }),
        projectItemNode({ number: 12, repo: "davidpoxon/roubo", state: "open" }),
      ]),
    );
    mocks.mockOctokit.graphql.mockResolvedValueOnce(noBlocking(10)); // page 1 blocking

    const page1 = await listIssues({
      sources,
      cursor: null,
      pageSize: 1,
      excludedStatuses: ["Done"],
    });
    expect(page1.items.map((i) => i.externalId)).toEqual(["davidpoxon/roubo#10"]);
    expect(decodeCompositeCursor(page1.nextCursor as string)).toEqual({ "davidpoxon/#1": "2" });

    // Page 2 is served from cache; only #12's blocking lookup is queued. The
    // excluded #11 left no gap, so #12 is the next (and last) item.
    mocks.mockOctokit.graphql.mockResolvedValueOnce(noBlocking(12));
    const page2 = await listIssues({
      sources,
      cursor: page1.nextCursor,
      pageSize: 1,
      excludedStatuses: ["Done"],
    });
    expect(page2.items.map((i) => i.externalId)).toEqual(["davidpoxon/roubo#12"]);
    expect(page2.nextCursor).toBeNull();
  });
});
