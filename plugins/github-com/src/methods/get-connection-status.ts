import type { ConnectionStatus, FetchInit, FetchResult } from "@roubo/plugin-sdk";
import { SECURITY_EVENTS_SCOPE, detectTokenScopes, scopeStatus } from "@roubo/shared-github";
import { getHost } from "../host-binding.js";

const GITHUB_API_BASE_URL = "https://api.github.com";

/**
 * Returns whether any of the three alert categories (Code Scanning, Secret
 * Scanning, Dependabot) is enabled for any configured source. Today this
 * always returns `false` because per-source category toggles do not yet exist
 * in the plugin's `configSchema`. When #106 lands and introduces those
 * toggles, this resolver reads the same plugin-side state the (future)
 * listIssues alert wiring reads and ORs the three booleans together.
 */
let resolveHasAlertCategoryEnabled: () => boolean = () => false;

/** Replace the gate resolver. Only call this in tests (and from #106's wiring). */
export function __setHasAlertCategoryEnabledForTests(resolver: () => boolean): void {
  resolveHasAlertCategoryEnabled = resolver;
}

export function __resetHasAlertCategoryEnabled(): void {
  resolveHasAlertCategoryEnabled = () => false;
}

/**
 * Reports plugin-level connectivity to the host. Probes `GET /user` once to
 * verify the credential, then inspects the `X-OAuth-Scopes` header to surface
 * an `auth-problem` when the token is missing the `security_events` scope and
 * the user has enabled at least one alert category. Both signals are needed:
 * tokens issued before #105 routinely lack `security_events`, so we MUST NOT
 * blanket-fail those users until they ask for alert data.
 *
 * The host caches this result for 30 s (plugin-manager.ts), so this method
 * intentionally performs no caching of its own.
 */
export async function getConnectionStatus(): Promise<ConnectionStatus> {
  const checkedAt = new Date().toISOString();
  const host = getHost();

  const token = await host.credentials.get("github-token");
  if (!token) {
    return {
      state: "auth-problem",
      detail: "GitHub token not set. Connect GitHub from the plugin's Configure dialog.",
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

  const result = await detectTokenScopes(transport, GITHUB_API_BASE_URL);

  if (result.kind === "error") {
    if (result.status === 401 || result.status === 403) {
      return {
        state: "auth-problem",
        detail: "GitHub token is invalid or expired.",
        checkedAt,
      };
    }
    return {
      state: "errored",
      detail: `Failed to reach GitHub: ${result.detail}`,
      checkedAt,
    };
  }

  if (resolveHasAlertCategoryEnabled()) {
    const status = scopeStatus(result, SECURITY_EVENTS_SCOPE);
    if (status === "lacking") {
      return {
        state: "auth-problem",
        detail:
          "GitHub token is missing the security_events scope required for the enabled alert categories. Re-authenticate to grant it.",
        checkedAt,
      };
    }
  }

  // `result` is narrowed to scopes|unknown here; both carry the best-effort
  // `login` parsed from the same GET /user probe. Surface it so the Configure
  // dialog can render "Connected as <login>" without a second request.
  return {
    state: "connected",
    checkedAt,
    ...(result.login ? { account: { login: result.login } } : {}),
  };
}
