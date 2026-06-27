/**
 * Project-board issue dedup for `listIssues` (issue #548).
 *
 * A GitHub Project (v2) board can list the same underlying issue in more than
 * one item (the same issue parked under two Status columns, or a board that
 * surfaces an issue twice). Before the fix, `listFromProject` sliced and
 * paginated the raw board items, so a duplicated issue:
 * - rendered twice inside a single page (the host page-level dedup collapses
 *   that), but
 * - could also straddle a page boundary, where neither the host's per-page
 *   dedup nor the client's blind page flatten would collapse it.
 *
 * The plugin now dedupes board items by issue identity (repo + number) before
 * pagination, so a board issue present in multiple items occupies exactly one
 * result slot regardless of page boundaries.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConfiguredSource } from "@roubo/plugin-sdk";
import { listIssues } from "../methods/list-issues.js";
import { installMocks, teardownMocks } from "./helpers.js";

function projectItemNode(opts: { number: number; repo: string; state: "open" | "closed" }) {
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
    fieldValueByName: null,
  };
}

function projectItemsResponse(nodes: unknown[]) {
  return {
    organization: {
      projectV2: {
        title: "Board",
        items: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
      },
    },
  };
}

function noBlocking(...issueNumbers: number[]) {
  const repository: Record<string, unknown> = {};
  for (const n of issueNumbers) {
    repository[`issue_${n}`] = {
      blockedBy: { nodes: [] },
      blocking: { nodes: [], pageInfo: { hasNextPage: false } },
    };
  }
  return { repository };
}

describe("listIssues project-board dedup (#548)", () => {
  let mocks: ReturnType<typeof installMocks>;

  beforeEach(() => {
    mocks = installMocks();
  });

  afterEach(() => {
    teardownMocks();
  });

  it("collapses an issue that appears in two board items to a single result", async () => {
    const sources: ConfiguredSource[] = [{ kind: "project", externalId: "davidpoxon/#1" }];

    mocks.mockOctokit.graphql.mockResolvedValueOnce(
      projectItemsResponse([
        projectItemNode({ number: 601, repo: "davidpoxon/roubo", state: "open" }),
        projectItemNode({ number: 601, repo: "davidpoxon/roubo", state: "open" }),
        projectItemNode({ number: 602, repo: "davidpoxon/roubo", state: "open" }),
      ]),
    );
    mocks.mockOctokit.graphql.mockResolvedValueOnce(noBlocking(601, 602));

    const result = await listIssues({ sources, cursor: null, pageSize: 50 });

    expect(result.items.map((i) => i.externalId)).toEqual([
      "davidpoxon/roubo#601",
      "davidpoxon/roubo#602",
    ]);
  });

  it("deduped board items are not re-queried for blocking relationships", async () => {
    // Slowness backstop (#548): a board issue listed twice must not produce two
    // blocking lookups. Dedup runs before the per-repo blocking fan-out, so the
    // duplicate never reaches `numbersByRepo`.
    const sources: ConfiguredSource[] = [{ kind: "project", externalId: "davidpoxon/#1" }];

    mocks.mockOctokit.graphql.mockResolvedValueOnce(
      projectItemsResponse([
        projectItemNode({ number: 601, repo: "davidpoxon/roubo", state: "open" }),
        projectItemNode({ number: 601, repo: "davidpoxon/roubo", state: "open" }),
      ]),
    );
    // Exactly one blocking call covering #601 once.
    mocks.mockOctokit.graphql.mockResolvedValueOnce(noBlocking(601));

    await listIssues({ sources, cursor: null, pageSize: 50 });

    // First graphql call = project items; second = blocking. No third call for a
    // duplicate #601.
    expect(mocks.mockOctokit.graphql).toHaveBeenCalledTimes(2);
    const blockingQuery = mocks.mockOctokit.graphql.mock.calls[1]?.[0] as string;
    expect(blockingQuery.match(/issue_601:/g) ?? []).toHaveLength(1);
  });

  it("fetches the project board once and serves later pages from cache (#548)", async () => {
    // Caching behaviour: the whole board is loaded on page 1 and cached, so
    // paging the same board does not re-run the project-items GraphQL query.
    const sources: ConfiguredSource[] = [{ kind: "project", externalId: "davidpoxon/#1" }];

    mocks.mockOctokit.graphql.mockResolvedValueOnce(
      projectItemsResponse([
        projectItemNode({ number: 1, repo: "davidpoxon/roubo", state: "open" }),
        projectItemNode({ number: 2, repo: "davidpoxon/roubo", state: "open" }),
      ]),
    );
    mocks.mockOctokit.graphql.mockResolvedValueOnce(noBlocking(1)); // page 1 blocking

    const page1 = await listIssues({ sources, cursor: null, pageSize: 1 });
    expect(page1.items.map((i) => i.externalId)).toEqual(["davidpoxon/roubo#1"]);

    mocks.mockOctokit.graphql.mockResolvedValueOnce(noBlocking(2)); // page 2 blocking only
    const page2 = await listIssues({ sources, cursor: page1.nextCursor, pageSize: 1 });
    expect(page2.items.map((i) => i.externalId)).toEqual(["davidpoxon/roubo#2"]);

    // graphql calls: page-1 project items + page-1 blocking + page-2 blocking.
    // No second project-items query: the board came from cache.
    expect(mocks.mockOctokit.graphql).toHaveBeenCalledTimes(3);
  });

  it("collapses a duplicate that would otherwise straddle a page boundary", async () => {
    const sources: ConfiguredSource[] = [{ kind: "project", externalId: "davidpoxon/#1" }];

    // #601 appears as item 1 and item 2. With pageSize 1 and raw-item slicing,
    // page 1 would yield #601 and page 2 would yield #601 again. After dedup,
    // page 1 is #601 and page 2 is #602.
    mocks.mockOctokit.graphql.mockResolvedValueOnce(
      projectItemsResponse([
        projectItemNode({ number: 601, repo: "davidpoxon/roubo", state: "open" }),
        projectItemNode({ number: 601, repo: "davidpoxon/roubo", state: "open" }),
        projectItemNode({ number: 602, repo: "davidpoxon/roubo", state: "open" }),
      ]),
    );
    mocks.mockOctokit.graphql.mockResolvedValueOnce(noBlocking(601));

    const page1 = await listIssues({ sources, cursor: null, pageSize: 1 });
    expect(page1.items.map((i) => i.externalId)).toEqual(["davidpoxon/roubo#601"]);

    mocks.mockOctokit.graphql.mockResolvedValueOnce(noBlocking(602));
    const page2 = await listIssues({ sources, cursor: page1.nextCursor, pageSize: 1 });
    expect(page2.items.map((i) => i.externalId)).toEqual(["davidpoxon/roubo#602"]);
    expect(page2.nextCursor).toBeNull();
  });
});
