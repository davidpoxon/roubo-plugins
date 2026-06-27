/**
 * TC-098: Performance harness for warm `listIssues` pulls.
 *
 * Spec (`.specifications/integration-plugins/test-cases.json`):
 *   - 5 sources x ~200 items, all three alert categories enabled
 *   - 30 sequential warm pulls; assert p95 < 8000ms (NFR-013)
 *   - Issues-only baseline recorded; alerts-disabled p95 within 10% of baseline
 *
 * Implementation notes:
 *   - Mocked Octokit + host.fetch responses settle in microseconds, so the
 *     numbers measured here reflect harness overhead, not real-network latency.
 *     The harness exists primarily to verify the measurement infrastructure +
 *     guard against pathological regressions (e.g. accidentally introduced
 *     O(n^2) work on the issue merge path); production p95 evidence comes from
 *     manual real-token runs and the `alert-fetch` log lines from WU-036.
 *   - Gated on `RUN_PERF_HARNESS=1` so the loop does not bloat the default
 *     coverage run. CI may opt in explicitly when collecting evidence.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ConfiguredSource, FetchInit, FetchResult } from "@roubo/plugin-sdk";
import { listIssues } from "../methods/list-issues.js";
import { resetAlertsRuntime } from "../alerts-runtime.js";
import { resetCaches } from "../github-request.js";
import { installMocks, okResponse, teardownMocks } from "./helpers.js";

const RUN = process.env.RUN_PERF_HARNESS === "1";

const SOURCES = ["alpha/repo", "bravo/repo", "charlie/repo", "delta/repo", "echo/repo"] as const;
const ISSUES_PER_SOURCE = 50; // page 1 size; the rest live behind pagination
const ALERTS_PER_CATEGORY = 50;
const WARM_PULLS = 30;
const P95_BUDGET_MS = 8000;

interface PullMetric {
  iteration: number;
  alertsEnabled: boolean;
  durationMs: number;
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? 0;
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

function buildSource(externalId: string, alertsEnabled: boolean): ConfiguredSource {
  return {
    kind: "repo",
    externalId,
    ...(alertsEnabled
      ? {
          includeCodeQLAlerts: true,
          includeSecretScanningAlerts: true,
          includeDependabotAlerts: true,
        }
      : {}),
  };
}

let mocks: ReturnType<typeof installMocks>;
let alertResponses: Map<string, FetchResult>;

function wireMocks(alertsEnabled: boolean) {
  alertResponses = new Map();
  if (alertsEnabled) {
    for (const repo of SOURCES) {
      for (const category of ["code-scanning", "secret-scanning", "dependabot"] as const) {
        alertResponses.set(alertUrl(repo, category), {
          status: 200,
          headers: {},
          body: buildAlertBody(category, ALERTS_PER_CATEGORY),
        });
      }
    }
  }
  mocks.mockHost.fetch.mockImplementation(async (url: string, _init?: FetchInit) => {
    const r = alertResponses.get(url);
    if (!r) throw new Error(`unexpected alert url ${url}`);
    return r;
  });

  // Octokit issues page + empty GraphQL blocking, repeated for every call.
  mocks.mockOctokit.request.mockImplementation(async (_route: string, params: unknown) => {
    const owner = (params as { owner?: string }).owner ?? "unknown";
    const repo = (params as { repo?: string }).repo ?? "unknown";
    return okResponse(buildIssuesPage(`${owner}/${repo}`, ISSUES_PER_SOURCE));
  });
  mocks.mockOctokit.graphql.mockImplementation(async () => ({ repository: {} }));
}

beforeEach(() => {
  resetAlertsRuntime();
  resetCaches();
  mocks = installMocks();
});

afterEach(() => {
  teardownMocks();
  resetAlertsRuntime();
  resetCaches();
});

async function runWarmPull(alertsEnabled: boolean): Promise<number> {
  // Per-pull: 5 sequential listIssues calls (one per configured source).
  // Clear TTL caches between pulls so each pull re-hits the request layer
  // (mirroring production where a 30s TTL almost always lapses between pulls).
  resetCaches();
  const start = performance.now();
  for (const externalId of SOURCES) {
    await listIssues({
      sources: [buildSource(externalId, alertsEnabled)],
      cursor: null,
      pageSize: 50,
    });
  }
  return performance.now() - start;
}

async function measureLoop(alertsEnabled: boolean): Promise<PullMetric[]> {
  // One warm-up pull to populate the ETag store + amortize any module-load cost.
  wireMocks(alertsEnabled);
  await runWarmPull(alertsEnabled);
  const metrics: PullMetric[] = [];
  for (let i = 0; i < WARM_PULLS; i++) {
    const durationMs = await runWarmPull(alertsEnabled);
    metrics.push({ iteration: i + 1, alertsEnabled, durationMs });
  }
  return metrics;
}

test.runIf(RUN)(
  "TC-098: p95 < 8000ms across 30 warm pulls, 5 sources x 200 items, all categories on",
  async () => {
    const baseline = await measureLoop(false);
    teardownMocks();
    resetAlertsRuntime();
    resetCaches();
    mocks = installMocks();
    const withAlerts = await measureLoop(true);

    const baselineP95 = p95(baseline.map((m) => m.durationMs));
    const withAlertsP95 = p95(withAlerts.map((m) => m.durationMs));

    // Surface the numbers on the test runner so engineers running with
    // RUN_PERF_HARNESS=1 can paste them into evidence comments.
    console.log(
      JSON.stringify(
        {
          kind: "perf-evidence",
          tc: "TC-098",
          warmPulls: WARM_PULLS,
          sources: SOURCES.length,
          itemsPerSource: ISSUES_PER_SOURCE + 3 * ALERTS_PER_CATEGORY,
          baselineP95Ms: baselineP95,
          withAlertsP95Ms: withAlertsP95,
        },
        null,
        2,
      ),
    );

    expect(withAlertsP95).toBeLessThan(P95_BUDGET_MS);
    expect(baselineP95).toBeLessThan(P95_BUDGET_MS);
  },
  120_000,
);

describe("TC-098 harness (smoke)", () => {
  test.runIf(!RUN)("is skipped unless RUN_PERF_HARNESS=1", () => {
    // Sentinel so the file always contributes one passing assertion under the
    // default coverage run (vitest fails files with zero discovered tests).
    expect(RUN).toBe(false);
  });
});
