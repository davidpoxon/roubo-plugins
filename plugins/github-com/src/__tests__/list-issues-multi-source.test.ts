/**
 * Multi-source `listIssues` aggregation.
 *
 * A submodule project surfaces several repo sources at once (the root repo plus
 * each submodule). `listIssues` must aggregate issues AND security alerts across
 * every source, not just the first. Before this fix the plugin only ever
 * processed `sources[0]`, so a submodule's Dependabot alert never reached the
 * cut list. Covers:
 * - first page fans issues + alerts across every repo source (the regression)
 * - composite cursor: only sources with a next page stay active; alerts are not
 *   re-fetched on later pages; exhausted sources drop out
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConfiguredSource, FetchResult } from "@roubo/plugin-sdk";
import { decodeCompositeCursor } from "@roubo/shared-github";
import { listIssues } from "../methods/list-issues.js";
import { resetAlertsRuntime } from "../alerts-runtime.js";
import { installMocks, okResponse, teardownMocks } from "./helpers.js";

interface InstalledMocks {
  mockHost: ReturnType<typeof installMocks>["mockHost"];
  mockOctokit: ReturnType<typeof installMocks>["mockOctokit"];
}

let mocks: InstalledMocks;

const ROOT = "acme/root";
const WEB = "acme/web";
const ROOT_DEP_URL = `https://api.github.com/repos/${ROOT}/dependabot/alerts?state=open&per_page=50`;
const WEB_DEP_URL = `https://api.github.com/repos/${WEB}/dependabot/alerts?state=open&per_page=50`;

function dependabotOnly(externalId: string): ConfiguredSource {
  return { kind: "repo", externalId, includeDependabotAlerts: true };
}

beforeEach(() => {
  resetAlertsRuntime();
  mocks = installMocks();
});

afterEach(() => {
  teardownMocks();
  resetAlertsRuntime();
});

/** Queue one empty issues page (no blocking graphql is issued for 0 issues). */
function queueEmptyIssuesPage() {
  mocks.mockOctokit.request.mockResolvedValueOnce(okResponse([]));
}

describe("listIssues multi-source aggregation", () => {
  it("fans alerts across every repo source so a submodule's Dependabot alert reaches the cut list", async () => {
    // Both repos have empty issue pages; each has one open Dependabot alert.
    queueEmptyIssuesPage(); // root issues
    queueEmptyIssuesPage(); // submodule issues
    mocks.mockHost.fetch.mockImplementation(async (url: string) => {
      if (url === ROOT_DEP_URL) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify([
            { number: 1, html_url: "root-dep", state: "open", created_at: "t" },
          ]),
        } satisfies FetchResult;
      }
      if (url === WEB_DEP_URL) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify([
            { number: 2, html_url: "web-dep", state: "open", created_at: "t" },
          ]),
        } satisfies FetchResult;
      }
      throw new Error(`unexpected url ${url}`);
    });

    const sources: ConfiguredSource[] = [dependabotOnly(ROOT), dependabotOnly(WEB)];
    const result = await listIssues({ sources, cursor: null, pageSize: 50 });

    // Both repos' alerts present, root before submodule (host source order).
    expect(result.items.map((i) => i.externalId)).toEqual([
      `${ROOT}#dependabot-1`,
      `${WEB}#dependabot-2`,
    ]);
    // Neither repo paginated, so the whole list fit on one page.
    expect(result.nextCursor).toBeNull();
    expect(result.warnings).toBeUndefined();
  });

  it("advances each source independently via the composite cursor and skips exhausted sources", async () => {
    // pageSize 1: root returns a full page (=> hasNextPage), submodule returns
    // an empty page (=> exhausted). Alerts are off so host.fetch is never hit.
    const rootIssue = {
      number: 10,
      title: "root issue",
      state: "open",
      html_url: "root-issue",
      updated_at: "t",
      labels: [],
      assignees: [],
    };
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse([rootIssue])); // root page 1 (full)
    mocks.mockOctokit.graphql.mockResolvedValueOnce({ repository: {} }); // root blocking
    queueEmptyIssuesPage(); // submodule page 1 (empty => exhausted)

    const sources: ConfiguredSource[] = [
      { kind: "repo", externalId: ROOT },
      { kind: "repo", externalId: WEB },
    ];
    const page1 = await listIssues({ sources, cursor: null, pageSize: 1 });

    expect(page1.items.map((i) => i.externalId)).toEqual([`${ROOT}#10`]);
    expect(page1.nextCursor).not.toBeNull();
    // Only the root repo carries forward; the exhausted submodule is gone.
    expect(decodeCompositeCursor(page1.nextCursor as string)).toEqual({ [ROOT]: "2" });
    expect(mocks.mockHost.fetch).not.toHaveBeenCalled();

    // Page 2: only root is queried (one issues request), no alerts, list ends.
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse([])); // root page 2 (empty)
    const page2 = await listIssues({ sources, cursor: page1.nextCursor, pageSize: 1 });

    expect(page2.items).toEqual([]);
    expect(page2.nextCursor).toBeNull();
    expect(mocks.mockHost.fetch).not.toHaveBeenCalled();
    // Exactly one issues request on page 2 (root only; submodule was dropped).
    expect(mocks.mockOctokit.request).toHaveBeenCalledTimes(3);
  });

  it("isolates a failing source so the others' alerts still reach the cut list", async () => {
    // Root's issues fetch throws (transient 5xx / missing repo). Before the fix
    // this rejected the whole Promise.all and blanked every source, including
    // the submodule's Dependabot alert. Now root degrades to a per-source
    // warning while the submodule's alert still reaches the cut list.
    mocks.mockOctokit.request.mockRejectedValueOnce(new Error("root issues boom")); // root issues -> throw
    queueEmptyIssuesPage(); // submodule issues -> empty
    mocks.mockHost.fetch.mockImplementation(async (url: string) => {
      if (url === WEB_DEP_URL) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify([
            { number: 2, html_url: "web-dep", state: "open", created_at: "t" },
          ]),
        } satisfies FetchResult;
      }
      throw new Error(`unexpected url ${url}`);
    });

    const sources: ConfiguredSource[] = [dependabotOnly(ROOT), dependabotOnly(WEB)];
    const result = await listIssues({ sources, cursor: null, pageSize: 50 });

    // Submodule's alert survives despite the root source failing.
    expect(result.items.map((i) => i.externalId)).toEqual([`${WEB}#dependabot-2`]);
    // Root's failure is surfaced as a per-source warning, not thrown.
    expect(result.warnings).toEqual([
      expect.objectContaining({
        category: "issues",
        sourceExternalId: ROOT,
        cause: expect.stringContaining("root issues boom"),
      }),
    ]);
    // Root failed on the first page (no prior cursor to retry), submodule had no
    // next page, so the list ends.
    expect(result.nextCursor).toBeNull();
    // Root's alerts were never fetched: it failed at the issues step.
    expect(mocks.mockHost.fetch).not.toHaveBeenCalledWith(ROOT_DEP_URL, expect.anything());
  });
});
