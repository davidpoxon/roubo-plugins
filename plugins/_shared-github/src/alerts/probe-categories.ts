/**
 * Per-category Test Connection probe for the GitHub-family plugins (WU-041).
 *
 * Picks a sample repo from the supplied source list (the first `kind: "repo"`
 * source with a parseable `owner/repo` externalId), does a cheap repo-level
 * pre-flight, then races a `per_page=1` GET against each enabled category
 * endpoint with a per-probe timeout. Reports map directly into the host's
 * `IntegrationCategoryReport` rows.
 *
 * Shared between github.com and GHE so the HTTP-status mapping is identical
 * across the two plugins.
 */

import type { FetchInit, FetchResult } from "@roubo/plugin-sdk";
import type { FetchTransport } from "../transport.js";
import { trimTrailingSlash } from "./code-scanning.js";

export type ProbeCategory = "code-scanning" | "secret-scanning" | "dependabot";

export type ProbeStatus = "ok" | "scope-missing" | "not-enabled" | "timed-out" | "error";

export interface ProbeReport {
  category: ProbeCategory;
  status: ProbeStatus;
  detail?: string;
  httpStatus?: number;
}

export interface ProbeSource {
  kind: string;
  externalId: string;
}

export interface ProbeAlertCategoriesArgs {
  baseUrl: string;
  transport: FetchTransport;
  sources: ProbeSource[];
  enabledCategories: ProbeCategory[];
  /** Per-probe timeout (ms). Default 5000 (FR-047: 5s per-probe cap). */
  timeoutMsPerProbe?: number;
  /** Forwarded as `allowSelfSignedTls` on each probe (GHE). */
  allowSelfSignedTls?: boolean;
}

const ALERT_PATH: Record<ProbeCategory, string> = {
  "code-scanning": "code-scanning/alerts",
  "secret-scanning": "secret-scanning/alerts",
  dependabot: "dependabot/alerts",
};

const DEFAULT_TIMEOUT_MS = 5_000;

function parseOwnerRepo(externalId: string): { owner: string; repo: string } | null {
  const slash = externalId.indexOf("/");
  if (slash <= 0 || slash === externalId.length - 1) return null;
  return { owner: externalId.slice(0, slash), repo: externalId.slice(slash + 1) };
}

function pickSampleRepo(sources: readonly ProbeSource[]): { owner: string; repo: string } | null {
  for (const source of sources) {
    if (source.kind !== "repo") continue;
    const parsed = parseOwnerRepo(source.externalId);
    if (parsed) return parsed;
  }
  return null;
}

function buildErrorReports(categories: readonly ProbeCategory[], detail: string): ProbeReport[] {
  return categories.map((category) => ({ category, status: "error" as const, detail }));
}

function buildNotEnabledReports(
  categories: readonly ProbeCategory[],
  detail: string,
): ProbeReport[] {
  return categories.map((category) => ({ category, status: "not-enabled" as const, detail }));
}

class ProbeTimeoutError extends Error {
  constructor() {
    super("Timed out");
    this.name = "ProbeTimeoutError";
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race<T>([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new ProbeTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const PROBE_HEADERS: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

function buildInit(allowSelfSignedTls: boolean | undefined): FetchInit {
  const init: FetchInit = { method: "GET", headers: { ...PROBE_HEADERS } };
  if (allowSelfSignedTls) init.allowSelfSignedTls = true;
  return init;
}

function repoUrl(baseUrl: string, owner: string, repo: string): string {
  return `${trimTrailingSlash(baseUrl)}/repos/${owner}/${repo}`;
}

function alertProbeUrl(
  baseUrl: string,
  owner: string,
  repo: string,
  category: ProbeCategory,
): string {
  return `${trimTrailingSlash(baseUrl)}/repos/${owner}/${repo}/${ALERT_PATH[category]}?per_page=1`;
}

function classifyResponse(category: ProbeCategory, res: FetchResult): ProbeReport {
  const status = res.status;
  if (status >= 200 && status < 300) {
    return { category, status: "ok", httpStatus: status };
  }
  if (status === 401) {
    return {
      category,
      status: "scope-missing",
      detail: "Token is invalid or expired.",
      httpStatus: status,
    };
  }
  if (status === 403) {
    return {
      category,
      status: "scope-missing",
      detail: "Token missing `security_events` scope.",
      httpStatus: status,
    };
  }
  if (status === 404) {
    return {
      category,
      status: "not-enabled",
      detail: "Not enabled for this repository.",
      httpStatus: status,
    };
  }
  if (status === 410) {
    return {
      category,
      status: "not-enabled",
      detail: "GitHub Advanced Security disabled for this repository.",
      httpStatus: status,
    };
  }
  if (status === 451) {
    return {
      category,
      status: "not-enabled",
      detail: "Unavailable for legal reasons.",
      httpStatus: status,
    };
  }
  return {
    category,
    status: "error",
    detail: `Unexpected HTTP ${status}.`,
    httpStatus: status,
  };
}

async function probeCategory(
  args: ProbeAlertCategoriesArgs,
  owner: string,
  repo: string,
  category: ProbeCategory,
  timeoutMs: number,
): Promise<ProbeReport> {
  const url = alertProbeUrl(args.baseUrl, owner, repo, category);
  try {
    const res = await withTimeout(
      args.transport(url, buildInit(args.allowSelfSignedTls)),
      timeoutMs,
    );
    return classifyResponse(category, res);
  } catch (err) {
    if (err instanceof ProbeTimeoutError) {
      return { category, status: "timed-out", detail: "Timed out" };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { category, status: "error", detail: message };
  }
}

/**
 * Run the per-category Test Connection probes for the GitHub-family plugins.
 * Always returns one report per requested category, in the same order.
 */
export async function probeAlertCategories(args: ProbeAlertCategoriesArgs): Promise<ProbeReport[]> {
  if (args.enabledCategories.length === 0) return [];

  const sample = pickSampleRepo(args.sources);
  if (!sample) {
    return buildNotEnabledReports(args.enabledCategories, "No repository source configured.");
  }

  const timeoutMs = args.timeoutMsPerProbe ?? DEFAULT_TIMEOUT_MS;

  // Pre-flight: confirm the sample repo is reachable so we don't misreport
  // every category as `not-enabled` when the underlying problem is auth or a
  // dead repo. The repo endpoint shares the same auth surface as the alert
  // endpoints, so 401/404 here means every category probe would lie.
  let preflight: FetchResult;
  try {
    preflight = await withTimeout(
      args.transport(
        repoUrl(args.baseUrl, sample.owner, sample.repo),
        buildInit(args.allowSelfSignedTls),
      ),
      timeoutMs,
    );
  } catch (err) {
    if (err instanceof ProbeTimeoutError) {
      return buildErrorReports(args.enabledCategories, "Timed out");
    }
    const message = err instanceof Error ? err.message : String(err);
    return buildErrorReports(args.enabledCategories, message);
  }

  if (preflight.status === 401 || preflight.status === 403) {
    return args.enabledCategories.map((category) => ({
      category,
      status: "scope-missing" as const,
      detail: "Token cannot read this repository.",
      httpStatus: preflight.status,
    }));
  }
  if (preflight.status === 404) {
    return buildErrorReports(args.enabledCategories, "Repository not accessible.");
  }
  if (preflight.status < 200 || preflight.status >= 300) {
    return buildErrorReports(
      args.enabledCategories,
      `Repository pre-flight returned HTTP ${preflight.status}.`,
    );
  }

  // FR-047: fan out per-category probes with `Promise.allSettled` so a single
  // rejected probe cannot short-circuit the others. `probeCategory` already
  // catches its own errors and never throws today, but using `allSettled` keeps
  // that isolation contract explicit and defends against any future probe
  // implementation that bubbles up.
  const categories = args.enabledCategories;
  const settled = await Promise.allSettled(
    categories.map((category) =>
      probeCategory(args, sample.owner, sample.repo, category, timeoutMs),
    ),
  );
  return categories.map((category, index) => {
    const entry = settled[index];
    if (!entry || entry.status === "fulfilled") {
      return entry?.value ?? { category, status: "error", detail: "Missing probe result." };
    }
    const message = entry.reason instanceof Error ? entry.reason.message : String(entry.reason);
    return { category, status: "error", detail: message };
  });
}
