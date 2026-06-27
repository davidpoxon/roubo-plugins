/**
 * GHE multi-source `listIssues` aggregation. Mirrors
 * `plugins/github-com/src/__tests__/list-issues-multi-source.test.ts` against the
 * GHE plugin (base URL `https://ghe.example.com/api/v3`, integrationId `ghe`).
 *
 * A submodule project surfaces the root repo plus each submodule; `listIssues`
 * must fan issues + alerts across every source, not just `sources[0]`, so a
 * submodule's Dependabot alert reaches the cut list.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConfiguredSource, FetchInit, FetchResult } from "@roubo/plugin-sdk";
import { decodeCompositeCursor } from "@roubo/shared-github";
import { listIssues } from "../methods/list-issues.js";
import { resetAlertsRuntime } from "../alerts-runtime.js";
import { installMocks, okResponse, teardownMocks } from "./helpers.js";

interface InstalledMocks {
  mockHost: ReturnType<typeof installMocks>["mockHost"];
  mockOctokit: ReturnType<typeof installMocks>["mockOctokit"];
}

let mocks: InstalledMocks;

const BASE = "https://ghe.example.com/api/v3";
const ROOT = "acme/root";
const WEB = "acme/web";
const ROOT_DEP_URL = `${BASE}/repos/${ROOT}/dependabot/alerts?state=open&per_page=50`;
const WEB_DEP_URL = `${BASE}/repos/${WEB}/dependabot/alerts?state=open&per_page=50`;

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

describe("listIssues multi-source aggregation (GHE)", () => {
  it("fans alerts across every repo source so a submodule's Dependabot alert reaches the cut list", async () => {
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse([])); // root issues
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse([])); // submodule issues
    mocks.mockHost.fetch.mockImplementation(async (url: string, _init?: FetchInit) => {
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

    expect(result.items.map((i) => i.externalId)).toEqual([
      `${ROOT}#dependabot-1`,
      `${WEB}#dependabot-2`,
    ]);
    expect(result.items.map((i) => i.integrationId)).toEqual(["ghe", "ghe"]);
    expect(result.nextCursor).toBeNull();
    expect(result.warnings).toBeUndefined();
  });

  it("carries only non-exhausted sources forward in the composite cursor", async () => {
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
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse([])); // submodule page 1 (empty)

    const sources: ConfiguredSource[] = [
      { kind: "repo", externalId: ROOT },
      { kind: "repo", externalId: WEB },
    ];
    const page1 = await listIssues({ sources, cursor: null, pageSize: 1 });

    expect(page1.items.map((i) => i.externalId)).toEqual([`${ROOT}#10`]);
    expect(decodeCompositeCursor(page1.nextCursor as string)).toEqual({ [ROOT]: "2" });
    expect(mocks.mockHost.fetch).not.toHaveBeenCalled();
  });

  it("isolates a failing source so the others' alerts still reach the cut list", async () => {
    // Root's issues fetch throws (transient 5xx / missing repo). Before the fix
    // this rejected the whole Promise.all and blanked every source, including
    // the submodule's Dependabot alert. Now root degrades to a per-source
    // warning while the submodule's alert still reaches the cut list.
    mocks.mockOctokit.request.mockRejectedValueOnce(new Error("root issues boom")); // root issues -> throw
    mocks.mockOctokit.request.mockResolvedValueOnce(okResponse([])); // submodule issues -> empty
    mocks.mockHost.fetch.mockImplementation(async (url: string, _init?: FetchInit) => {
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
    expect(result.items.map((i) => i.integrationId)).toEqual(["ghe"]);
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
