import { Octokit } from "octokit";
import { tryGetActiveConfig } from "./active-config.js";
import { getHost } from "./host-binding.js";
import { createHostFetchAdapter } from "./host-fetch-adapter.js";

/** Minimum surface githubRequest uses; tests can substitute a mock with the same shape. */
export interface OctokitLike {
  request: (
    route: string,
    params?: Record<string, unknown>,
  ) => Promise<{
    data: unknown;
    headers?: Record<string, string | undefined>;
    status: number;
  }>;
  graphql: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;
}

let octokit: OctokitLike | null = null;
let cachedBaseUrl: string | null = null;
let tokenLoaded = false;
let cachedToken: string | null = null;
let injectedForTests: OctokitLike | null = null;

/** Replace the singleton Octokit instance. Only call this in tests. */
export function __setOctokitForTests(client: OctokitLike | null): void {
  injectedForTests = client;
}

function buildBaseUrl(instance: string): string {
  return `${instance.replace(/\/$/, "")}/api/v3`;
}

/**
 * Returns a singleton Octokit instance authenticated with the token stored at
 * the `token` credential slot, configured against the active GHE instance's
 * `/api/v3` base URL, with `request.fetch` wired through the host. The token
 * is loaded lazily on first use and cached for the process lifetime. The
 * Octokit instance is rebuilt when the active config's `instance` changes
 * (e.g. the user reconfigures the plugin without restarting the process).
 * Call `resetOctokit()` to clear the cache explicitly (e.g. on token
 * rotation).
 */
export async function getOctokit(): Promise<OctokitLike> {
  if (injectedForTests) return injectedForTests;

  const config = tryGetActiveConfig();
  if (!config) {
    throw new Error(
      "[ghe] No active configuration. The host must call validateConfig before invoking source-scoped methods.",
    );
  }

  const baseUrl = buildBaseUrl(config.instance);
  if (octokit && cachedBaseUrl === baseUrl) return octokit;

  const host = getHost();
  if (!tokenLoaded) {
    cachedToken = await host.credentials.get("token");
    tokenLoaded = true;
  }

  if (!cachedToken) {
    throw new Error(
      "[ghe] GHE token missing. Set the token credential slot before invoking the plugin.",
    );
  }

  octokit = new Octokit({
    auth: cachedToken,
    baseUrl,
    request: {
      fetch: createHostFetchAdapter(host, () => tryGetActiveConfig()?.allowSelfSignedTls ?? false),
    },
  }) as unknown as OctokitLike;
  cachedBaseUrl = baseUrl;
  return octokit;
}

/**
 * Clear the cached Octokit instance, baseUrl, and token so the next
 * `getOctokit()` call re-resolves them. Used in production by
 * setActiveConfig / validateConfig after a token rotation (WU-032 AC #7).
 * Does NOT clear `injectedForTests` (that state belongs to
 * `__setOctokitForTests`); clearing it here would kill any in-flight
 * test mock.
 */
export function resetOctokit(): void {
  octokit = null;
  cachedBaseUrl = null;
  tokenLoaded = false;
  cachedToken = null;
}
