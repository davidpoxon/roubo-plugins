import { Octokit } from "octokit";
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
let cachedToken: string | null = null;
let injectedForTests: OctokitLike | null = null;

/** Replace the singleton Octokit instance. Only call this in tests. */
export function __setOctokitForTests(client: OctokitLike | null): void {
  injectedForTests = client;
}

/**
 * Returns a singleton Octokit instance authenticated with the token stored at
 * the `github-token` credential slot, with `request.fetch` wired through the
 * host. A successfully-loaded token is cached for the process lifetime; a
 * missing token is NOT cached so the next call (after an OAuth completes)
 * picks it up without requiring a plugin restart. Call `resetOctokit()` to
 * force a re-read (e.g. on token rotation).
 */
export async function getOctokit(): Promise<OctokitLike> {
  if (injectedForTests) return injectedForTests;
  if (octokit) return octokit;

  const host = getHost();
  if (!cachedToken) {
    cachedToken = await host.credentials.get("github-token");
  }

  if (!cachedToken) {
    throw new Error(
      "[github-com] GitHub token missing. Set the github-token credential slot before invoking the plugin.",
    );
  }

  octokit = new Octokit({
    auth: cachedToken,
    request: { fetch: createHostFetchAdapter(host) },
  }) as unknown as OctokitLike;
  return octokit;
}

/**
 * Clear the cached Octokit instance and token so the next `getOctokit()`
 * call re-reads from the keyring. Used in production by validateConfig
 * after a token rotation (WU-032 AC #7). Does NOT clear `injectedForTests`
 * (that state belongs to `__setOctokitForTests`); clearing it here would
 * kill any in-flight test mock.
 */
export function resetOctokit(): void {
  octokit = null;
  cachedToken = null;
}
