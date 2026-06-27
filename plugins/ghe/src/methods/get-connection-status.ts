import type { ConnectionStatus, FetchInit, FetchResult } from "@roubo/plugin-sdk";
import { SECURITY_EVENTS_SCOPE, detectTokenScopes, scopeStatus } from "@roubo/shared-github";
import { tryGetActiveConfig } from "../active-config.js";
import { getHost } from "../host-binding.js";

/**
 * Returns whether any of the three alert categories (Code Scanning, Secret
 * Scanning, Dependabot) is enabled for any configured source. Today this
 * always returns `false` because per-source category toggles do not yet exist
 * in the plugin's `configSchema`. When #107 lands and introduces those
 * toggles, this resolver reads the same plugin-side state the (future)
 * listIssues alert wiring reads and ORs the three booleans together.
 */
let resolveHasAlertCategoryEnabled: () => boolean = () => false;

/** Replace the gate resolver. Only call this in tests (and from #107's wiring). */
export function __setHasAlertCategoryEnabledForTests(resolver: () => boolean): void {
  resolveHasAlertCategoryEnabled = resolver;
}

export function __resetHasAlertCategoryEnabled(): void {
  resolveHasAlertCategoryEnabled = () => false;
}

function buildBaseUrl(instance: string): string {
  return `${instance.replace(/\/$/, "")}/api/v3`;
}

/**
 * Reports plugin-level connectivity to the host. Probes `GET {instance}/api/v3/user`
 * once to verify the credential, then inspects the `X-OAuth-Scopes` header to
 * surface an `auth-problem` when the token is missing the `security_events`
 * scope and the user has enabled at least one alert category. Fine-grained
 * PATs and GitHub App installation tokens do not emit `X-OAuth-Scopes` at
 * all (NFR-015); for those, scopeStatus returns `unknown` and we keep the
 * status as connected rather than fabricate a false-positive warning.
 *
 * The host caches this result for 30 s (plugin-manager.ts), so this method
 * intentionally performs no caching of its own.
 */
export async function getConnectionStatus(): Promise<ConnectionStatus> {
  const checkedAt = new Date().toISOString();
  const config = tryGetActiveConfig();
  if (!config) {
    return {
      state: "errored",
      detail:
        "No active GHE configuration. The host must call validateConfig (with at least { instance }) before getConnectionStatus.",
      checkedAt,
    };
  }

  const host = getHost();
  const token = await host.credentials.get("token");
  if (!token) {
    return {
      state: "auth-problem",
      detail: "GHE token not set. Connect GHE from the plugin's Configure dialog.",
      checkedAt,
    };
  }

  const transport = async (url: string, init?: FetchInit): Promise<FetchResult> =>
    host.fetch(url, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    });

  const result = await detectTokenScopes(transport, buildBaseUrl(config.instance), {
    allowSelfSignedTls: config.allowSelfSignedTls,
  });

  if (result.kind === "error") {
    if (result.status === 401 || result.status === 403) {
      return {
        state: "auth-problem",
        detail: "GHE token is invalid or expired.",
        checkedAt,
      };
    }
    return {
      state: "errored",
      detail: `Failed to reach GHE: ${result.detail}`,
      checkedAt,
    };
  }

  if (resolveHasAlertCategoryEnabled()) {
    const status = scopeStatus(result, SECURITY_EVENTS_SCOPE);
    if (status === "lacking") {
      return {
        state: "auth-problem",
        detail:
          "GHE token is missing the security_events scope required for the enabled alert categories. Regenerate the token on the GHE instance with that scope and paste it back.",
        checkedAt,
      };
    }
  }

  return { state: "connected", checkedAt };
}
