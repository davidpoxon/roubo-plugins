// This module is a verbatim port of server/services/github.ts:23-330 — the
// helper bodies, constants, comments, and variable names are intentionally
// preserved so a future diff against the legacy module makes the parity obvious.
// Only the entry points are adapted: getOctokit() comes from the plugin-local
// factory (which configures Octokit with a host.fetch adapter), and sleepImpl
// is a module-local injectable rather than the legacy __setSleepForTests
// indirection.

import { getOctokit } from "./octokit-factory.js";

// ── Module-level state ──

const MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 60_000;

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export const CACHE_TTL = 30_000;
const MAX_CACHE_SIZE = 100;

/**
 * Five 30s TTL caches mirroring the legacy module. They are exported so the
 * fetchers in github-fetchers.ts can populate and read them with the same
 * keying scheme as the legacy implementation.
 */
export const issueCache = new Map<string, CacheEntry<unknown>>();
export const projectCache = new Map<string, CacheEntry<unknown>>();
export const projectItemCache = new Map<string, CacheEntry<unknown>>();
export const blockingCache = new Map<string, CacheEntry<unknown>>();
export const issueTypesCache = new Map<string, CacheEntry<unknown>>();

// ETag store: separate from TTL caches. TTL caches skip the network entirely
// within 30s; ETag caching skips data transfer on requests that miss the TTL
// window by sending If-None-Match and handling 304 Not Modified. Only GET
// requests participate in ETag caching.
interface EtagEntry {
  etag: string;
  data: unknown;
}

const MAX_ETAG_ENTRIES = 200;
const etagStore = new Map<string, EtagEntry>();

// Injectable sleep for testability — avoids fake-timer fragility with vi.resetModules()
let sleepImpl: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

/** Replace the sleep implementation. Only call this in tests. */
export function __setSleepForTests(fn: (ms: number) => Promise<void>): void {
  sleepImpl = fn;
}

/** Clear all caches + ETag store. Used by the test suite and on token rotation. */
export function resetCaches(): void {
  issueCache.clear();
  projectCache.clear();
  projectItemCache.clear();
  blockingCache.clear();
  issueTypesCache.clear();
  etagStore.clear();
}

// ── Cache helpers ──

export function pruneCache<T>(cache: Map<string, CacheEntry<T>>): void {
  if (cache.size <= MAX_CACHE_SIZE) return;
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.timestamp >= CACHE_TTL) {
      cache.delete(key);
    }
  }
  while (cache.size > MAX_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
    else break;
  }
}

function pruneEtagStore(): void {
  while (etagStore.size > MAX_ETAG_ENTRIES) {
    const oldest = etagStore.keys().next().value;
    if (oldest !== undefined) etagStore.delete(oldest);
    else break;
  }
}

export function parseRepo(repoFullName: string): { owner: string; repo: string } {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) {
    throw new Error(`[ghe] Invalid repo name: ${repoFullName}. Expected format: owner/repo`);
  }
  return { owner, repo };
}

// ── githubRequest helper ──

export type GitHubRequestInput =
  | { kind: "rest"; route: string; params?: Record<string, unknown>; etag?: boolean }
  | { kind: "graphql"; query: string; variables?: Record<string, unknown>; opName?: string };

export type GitHubRequestResult<T> =
  | { kind: "rest"; notModified: false; data: T; etag: string | undefined; status: number }
  | { kind: "rest"; notModified: true; data: T; etag: string; status: 304 }
  | { kind: "graphql"; data: T };

/** JSON.stringify with keys sorted alphabetically at every level for stable key generation. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const sorted = Object.keys(value as object)
    .sort()
    .map((k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k]));
  return "{" + sorted.join(",") + "}";
}

/**
 * Builds the ETag store key for a REST request.
 * Substitutes path params into the URL template and serializes the remaining
 * query params stably so keys are consistent regardless of param insertion order.
 */
function buildEtagKey(route: string, params?: Record<string, unknown>): string {
  const spaceIdx = route.indexOf(" ");
  if (spaceIdx === -1) return route; // no method prefix — skip ETag keying
  const method = route.slice(0, spaceIdx);
  const urlTemplate = route.slice(spaceIdx + 1);

  const pathParams = new Set<string>();
  const url = urlTemplate.replace(/\{(\w+)\}/g, (_, key: string) => {
    pathParams.add(key);
    return params?.[key] !== undefined ? String(params[key]) : `{${key}}`;
  });

  const query: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (!pathParams.has(k) && k !== "headers") {
      query[k] = v;
    }
  }

  return `${method} ${url}?${stableStringify(query)}`;
}

/** Duck-type guard for Octokit-style request errors (also matches plain mocked error objects). */
function isRequestError(err: unknown): err is {
  status: number;
  response?: { headers: Record<string, string | undefined> };
  message?: string;
} {
  return (
    err !== null &&
    typeof err === "object" &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number"
  );
}

/**
 * Returns the number of milliseconds to wait before retrying, or null if the
 * error is not a rate-limit and should be re-thrown immediately.
 */
function computeBackoffMs(err: unknown, attempt: number): number | null {
  if (!isRequestError(err)) return null;

  const { status } = err;
  const headers = err.response?.headers ?? {};
  const message = err.message ?? "";

  const exponential = (): number =>
    Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, attempt) + Math.random() * 250);

  if (status === 429) {
    const retryAfter = headers["retry-after"];
    if (retryAfter) {
      const parsed = parseInt(retryAfter, 10);
      if (!isNaN(parsed)) return Math.min(parsed * 1000, MAX_BACKOFF_MS);
    }
    return exponential();
  }

  if (status === 403) {
    // Primary rate limit: GitHub signals remaining=0 + reset time
    if (headers["x-ratelimit-remaining"] === "0") {
      const reset = headers["x-ratelimit-reset"];
      if (reset) {
        const waitMs = parseInt(reset, 10) * 1000 - Date.now();
        return Math.min(Math.max(waitMs, 0), MAX_BACKOFF_MS);
      }
      return exponential();
    }
    // Secondary rate limit: detected via message
    if (/secondary rate limit|abuse/i.test(message)) {
      const retryAfter = headers["retry-after"];
      if (retryAfter) {
        const parsed = parseInt(retryAfter, 10);
        if (!isNaN(parsed)) return Math.min(parsed * 1000, MAX_BACKOFF_MS);
      }
      return exponential();
    }
  }

  return null;
}

/**
 * Central GitHub API helper. Handles auth (via getOctokit), rate-limit backoff
 * with retry, and ETag/If-None-Match caching for GET requests.
 *
 * REST requests use raw octokit.request() for a uniform response envelope
 * (data, headers, status). GraphQL requests use octokit.graphql(); they inherit
 * auth and backoff but do not participate in ETag caching.
 *
 * On 304 Not Modified, returns { notModified: true, data } where data is the
 * previously-cached response body. Callers can inspect notModified to skip
 * downstream work (useful for Phase 2 PR sync); existing callers simply use .data.
 */
export async function githubRequest<T>(input: GitHubRequestInput): Promise<GitHubRequestResult<T>> {
  const client = await getOctokit();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (input.kind === "graphql") {
        const data = await client.graphql<T>(input.query, input.variables ?? {});
        return { kind: "graphql", data };
      }

      // REST: use raw request() for uniform headers/status access
      const spaceIdx = input.route.indexOf(" ");
      const method = input.route.slice(0, spaceIdx);
      const useEtag = (input.etag ?? true) && method === "GET";
      const key = useEtag ? buildEtagKey(input.route, input.params) : undefined;
      const cached = key !== undefined ? etagStore.get(key) : undefined;

      const headers: Record<string, string> = {};
      if (cached) headers["if-none-match"] = cached.etag;

      let res;
      try {
        res = await client.request(input.route, { ...input.params, headers });
      } catch (innerErr) {
        // Octokit throws RequestError on 304 — return cached data with sentinel
        if (isRequestError(innerErr) && innerErr.status === 304) {
          if (cached) {
            return {
              kind: "rest",
              notModified: true,
              data: cached.data as T,
              etag: cached.etag,
              status: 304,
            };
          }
          // 304 with no cached data — cache was cleared between request dispatch and
          // response receipt (e.g., concurrent resetOctokit call). Throw a clear error
          // rather than propagating the raw 304 object to callers.
          throw new Error("[github] Unexpected 304 Not Modified with no cached ETag data", {
            cause: innerErr,
          });
        }
        throw innerErr;
      }

      // Some Octokit plugin configurations may surface 304 as a normal response
      if (res.status === 304) {
        if (cached) {
          return {
            kind: "rest",
            notModified: true,
            data: cached.data as T,
            etag: cached.etag,
            status: 304,
          };
        }
        throw new Error("[github] Unexpected 304 Not Modified with no cached ETag data");
      }

      const etag = res.headers?.etag as string | undefined;
      if (useEtag && key !== undefined && etag) {
        etagStore.set(key, { etag, data: res.data });
        pruneEtagStore();
      }

      return { kind: "rest", notModified: false, data: res.data as T, etag, status: res.status };
    } catch (err) {
      const wait = computeBackoffMs(err, attempt);
      if (wait === null || attempt >= MAX_RETRIES) throw err;
      await sleepImpl(wait);
    }
  }

  // Unreachable: the loop always returns or throws before exhausting iterations.
  throw new Error("[github] githubRequest: internal error");
}
