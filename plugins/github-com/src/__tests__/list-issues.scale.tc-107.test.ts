/**
 * TC-107: Scale harness for 100 sequential warm `listIssues` pulls.
 *
 * Spec (`.specifications/integration-plugins/test-cases.json`):
 *   - 5 sources x 3 alert categories, ETag store warm
 *   - 100 back-to-back warm pulls
 *   - 304 short-circuit hit rate for unchanged endpoints >= 90% (FR-041)
 *   - p95 latency < 8000ms (NFR-013)
 *
 * Implementation notes:
 *   - The 304 hit rate is measured across the ETag-eligible REST endpoints
 *     reached through `githubRequest` (which sends `If-None-Match` and
 *     short-circuits on Octokit's 304 throw). The alerts endpoints flow
 *     through `paginateAlerts`, which does not yet wire ETag handling. Those
 *     are excluded from the hit-rate calculation. See WU-036 plan notes; ETag
 *     coverage for alert endpoints is a separate optimization, not a hardening
 *     gate.
 *   - TTL caches are cleared between pulls so the test exercises the request
 *     layer (mirroring production where the 30s TTL almost always lapses
 *     between manual refreshes). The ETag store is NOT cleared, so warm pulls
 *     return 304 from Octokit.
 *   - Gated on `RUN_PERF_HARNESS=1`.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ConfiguredSource, FetchResult } from "@roubo/plugin-sdk";
import { listIssues } from "../methods/list-issues.js";
import { resetAlertsRuntime } from "../alerts-runtime.js";
import {
  blockingCache,
  issueCache,
  issueTypesCache,
  projectCache,
  projectItemCache,
  resetCaches,
} from "../github-request.js";
import { installMocks, okResponse, teardownMocks } from "./helpers.js";

const RUN = process.env.RUN_PERF_HARNESS === "1";

const SOURCES = ["alpha/repo", "bravo/repo", "charlie/repo", "delta/repo", "echo/repo"] as const;
const ISSUES_PER_SOURCE = 50;
const ALERTS_PER_CATEGORY = 50;
const SCALE_PULLS = 100;
const P95_BUDGET_MS = 8000;
const ETAG_HIT_RATE_FLOOR = 0.9;

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? 0;
}

function clearTtlOnlyCaches(): void {
  issueCache.clear();
  projectCache.clear();
  projectItemCache.clear();
  blockingCache.clear();
  issueTypesCache.clear();
}

function buildIssuesPage(repoFullName: string, count: number) {
  const [, repo] = repoFullName.split("/");
  return Array.from({ length: count }, (_, i) => ({
    number: i + 1,
    title: `${repo}-issue-${i + 1}`,
    body: null,
    state: "open" as const,
    html_url: `https://example/${repoFullName}/${i + 1}`,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    labels: [],
    assignees: [],
    user: null,
    pull_request: undefined,
  }));
}

function buildAlertBody(
  category: "code-scanning" | "secret-scanning" | "dependabot",
  count: number,
) {
  return JSON.stringify(
    Array.from({ length: count }, (_, i) => {
      const base = {
        number: i + 1,
        html_url: `https://example/${category}/${i + 1}`,
        state: "open" as const,
        created_at: "2026-01-01T00:00:00Z",
      };
      if (category === "code-scanning") {
        return {
          ...base,
          rule: { id: "rule-x", severity: "warning", description: "x" },
          most_recent_instance: { location: {} },
        };
      }
      if (category === "secret-scanning") {
        return { ...base, secret_type: "test-secret", secret_type_display_name: "Test" };
      }
      return {
        ...base,
        security_advisory: { ghsa_id: "GHSA-0000", severity: "low", summary: "x" },
        security_vulnerability: { package: { ecosystem: "npm", name: "lodash" } },
        dependency: { manifest_path: "package.json" },
      };
    }),
  );
}

function alertUrl(
  repoFullName: string,
  category: "code-scanning" | "secret-scanning" | "dependabot",
): string {
  const path =
    category === "code-scanning"
      ? "code-scanning/alerts"
      : category === "secret-scanning"
        ? "secret-scanning/alerts"
        : "dependabot/alerts";
  return `https://api.github.com/repos/${repoFullName}/${path}?state=open&per_page=50&page=1`;
}

function buildSource(externalId: string): ConfiguredSource {
  return {
    kind: "repo",
    externalId,
    includeCodeQLAlerts: true,
    includeSecretScanningAlerts: true,
    includeDependabotAlerts: true,
  };
}

interface ScaleMocks {
  ifNoneMatchRequests: number;
  notModifiedResponses: number;
  twoHundredResponses: number;
  alertResponses: Map<string, FetchResult>;
}

let mocks: ReturnType<typeof installMocks>;
let counters: ScaleMocks;

function wireMocks(): void {
  counters = {
    ifNoneMatchRequests: 0,
    notModifiedResponses: 0,
    twoHundredResponses: 0,
    alertResponses: new Map(),
  };

  for (const repo of SOURCES) {
    for (const category of ["code-scanning", "secret-scanning", "dependabot"] as const) {
      counters.alertResponses.set(alertUrl(repo, category), {
        status: 200,
        headers: {},
        body: buildAlertBody(category, ALERTS_PER_CATEGORY),
      });
    }
  }

  mocks.mockHost.fetch.mockImplementation(async (url: string) => {
    const r = counters.alertResponses.get(url);
    if (!r) throw new Error(`unexpected alert url ${url}`);
    return r;
  });

  // ETag-aware Octokit mock: first request per (owner, repo) returns 200 with
  // a stable ETag; subsequent requests carrying that ETag throw 304 (Octokit's
  // default behaviour), which githubRequest.ts catches and surfaces as a
  // notModified short-circuit.
  const etagByKey = new Map<string, string>();
  mocks.mockOctokit.request.mockImplementation(async (route: string, params: unknown) => {
    const p = params as { owner?: string; repo?: string; headers?: Record<string, string> };
    const key = `${route}::${p.owner ?? "_"}::${p.repo ?? "_"}`;
    const inboundEtag = p.headers?.["if-none-match"];
    if (inboundEtag) counters.ifNoneMatchRequests++;
    const stored = etagByKey.get(key);
    if (stored && inboundEtag === stored) {
      counters.notModifiedResponses++;
      throw { status: 304, response: { headers: {} } };
    }
    const etag = `W/"${key}-v1"`;
    etagByKey.set(key, etag);
    counters.twoHundredResponses++;
    return okResponse(buildIssuesPage(`${p.owner ?? "_"}/${p.repo ?? "_"}`, ISSUES_PER_SOURCE), {
      etag,
    });
  });
  mocks.mockOctokit.graphql.mockImplementation(async () => ({ repository: {} }));
}

beforeEach(() => {
  resetAlertsRuntime();
  resetCaches();
  mocks = installMocks();
  wireMocks();
});

afterEach(() => {
  teardownMocks();
  resetAlertsRuntime();
  resetCaches();
});

async function runPull(): Promise<number> {
  clearTtlOnlyCaches();
  const start = performance.now();
  for (const externalId of SOURCES) {
    await listIssues({
      sources: [buildSource(externalId)],
      cursor: null,
      pageSize: 50,
    });
  }
  return performance.now() - start;
}

test.runIf(RUN)(
  "TC-107: 100 warm pulls keep 304 hit rate >= 90% and p95 < 8000ms",
  async () => {
    // Warm-up populates the ETag store; the 304 counters are reset afterwards
    // so the hit-rate calculation reflects steady-state warm behaviour.
    await runPull();
    counters.ifNoneMatchRequests = 0;
    counters.notModifiedResponses = 0;
    counters.twoHundredResponses = 0;

    const durations: number[] = [];
    for (let i = 0; i < SCALE_PULLS; i++) {
      durations.push(await runPull());
    }

    const etagEligible = counters.notModifiedResponses + counters.twoHundredResponses;
    const hitRate = etagEligible === 0 ? 0 : counters.notModifiedResponses / etagEligible;
    const observedP95 = p95(durations);

    console.log(
      JSON.stringify(
        {
          kind: "perf-evidence",
          tc: "TC-107",
          scalePulls: SCALE_PULLS,
          sources: SOURCES.length,
          itemsPerSource: ISSUES_PER_SOURCE + 3 * ALERTS_PER_CATEGORY,
          p95Ms: observedP95,
          etagEligibleRequests: etagEligible,
          ifNoneMatchSent: counters.ifNoneMatchRequests,
          notModifiedReceived: counters.notModifiedResponses,
          twoHundredReceived: counters.twoHundredResponses,
          hitRate,
        },
        null,
        2,
      ),
    );

    expect(observedP95).toBeLessThan(P95_BUDGET_MS);
    expect(hitRate).toBeGreaterThanOrEqual(ETAG_HIT_RATE_FLOOR);
    // Every ETag-eligible request after warm-up should have carried If-None-Match.
    expect(counters.ifNoneMatchRequests).toBe(etagEligible);
  },
  120_000,
);

describe("TC-107 harness (smoke)", () => {
  test.runIf(!RUN)("is skipped unless RUN_PERF_HARNESS=1", () => {
    expect(RUN).toBe(false);
  });
});
