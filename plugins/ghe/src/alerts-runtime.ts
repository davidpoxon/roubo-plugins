/**
 * Per-repo dispatcher for the three Code/Secret/Dependabot alert categories.
 *
 * Wraps the `_shared-github` fetchers with `safeFetchAlerts` so per-category
 * fetch failures degrade to a `ListIssuesWarning` rather than throwing the
 * whole `listIssues` call. Only invoked on page 1 of a `listIssues` call;
 * `paginateAlerts` walks all alert pages internally, so subsequent issue
 * pages MUST NOT re-fetch.
 *
 * Mirrors `plugins/github-com/src/alerts-runtime.ts` with three GHE-specific
 * differences: the REST base URL is derived from the active config's instance
 * URL (`<instance>/api/v3`), the credential slot is `"token"` (not
 * `"github-token"`), and the `FetchInit` carries `allowSelfSignedTls: true`
 * when the active config opts in, so self-signed GHE instances stay reachable.
 *
 * NFR-015 contract: when any category returns `missing-scope` (HTTP 401), we
 * probe `/user` once to detect fine-grained PATs / GitHub App tokens that do
 * not emit `X-OAuth-Scopes`, and rewrite those warnings to a graceful
 * `scope-unverifiable` variant.
 */

import type { FetchInit, FetchResult, ListIssuesWarning, NormalizedIssue } from "@roubo/plugin-sdk";
import {
  detectTokenScopes,
  fetchCodeScanningAlert,
  fetchCodeScanningAlerts,
  fetchDependabotAlert,
  fetchDependabotAlerts,
  fetchSecretScanningAlert,
  fetchSecretScanningAlerts,
  mapCodeScanningAlertToNormalizedIssue,
  mapDependabotAlertToNormalizedIssue,
  mapSecretScanningAlertToNormalizedIssue,
  safeFetchAlerts,
  type AlertCategory,
  type FetchTransport,
} from "@roubo/shared-github";
import { getActiveConfig, tryGetActiveConfig } from "./active-config.js";
import { getHost } from "./host-binding.js";
import { INTEGRATION_ID } from "./normalize.js";

/**
 * NFR-015 graceful copy for fine-grained PATs / GitHub App installation
 * tokens that do not emit the `X-OAuth-Scopes` response header. Client
 * renders this verbatim as the chip tooltip. Do not edit casually.
 */
export const SCOPE_UNVERIFIABLE_CAUSE =
  "Unable to verify token scopes. If category data is missing, regenerate your token with the security alert permission.";

export interface AlertFlags {
  includeCodeQLAlerts?: boolean;
  includeSecretScanningAlerts?: boolean;
  includeDependabotAlerts?: boolean;
}

export interface FetchRepoAlertsResult {
  items: NormalizedIssue[];
  /**
   * Warnings emitted by this dispatch. `sourceExternalId` is left for the
   * caller to fill: it is the configured-source id (e.g. the project source
   * `owner/#42`), which a project that spans multiple repos shares across
   * its per-repo dispatches.
   */
  warnings: Array<Omit<ListIssuesWarning, "sourceExternalId">>;
}

let cachedToken: string | null = null;
let cachedScopeProbe: Promise<"known" | "unknown"> | null = null;

function buildBaseUrl(instance: string): string {
  return `${instance.replace(/\/$/, "")}/api/v3`;
}

async function getTransport(): Promise<FetchTransport> {
  const host = getHost();
  if (!cachedToken) {
    cachedToken = await host.credentials.get("token");
  }
  const token = cachedToken;
  return async (url: string, init?: FetchInit): Promise<FetchResult> => {
    const headers: Record<string, string> = { ...(init?.headers ?? {}) };
    if (token && !headers.Authorization && !headers.authorization) {
      headers.Authorization = `Bearer ${token}`;
    }
    const forwarded: FetchInit = { ...init, headers };
    // Resolve TLS flag per-call so reconfigurations land without a restart;
    // matches the resolver pattern in host-fetch-adapter.ts.
    if (tryGetActiveConfig()?.allowSelfSignedTls === true) {
      forwarded.allowSelfSignedTls = true;
    }
    return host.fetch(url, forwarded);
  };
}

/**
 * One-shot probe of `/user` to detect whether the current token emits
 * `X-OAuth-Scopes`. Cached per process; cleared by `resetAlertsRuntime()`.
 * Returns `"unknown"` for fine-grained PATs / GitHub App tokens (NFR-015)
 * so callers can rewrite a `missing-scope` warning to `scope-unverifiable`.
 */
async function probeTokenShape(
  transport: FetchTransport,
  baseUrl: string,
  allowSelfSignedTls: boolean,
): Promise<"known" | "unknown"> {
  if (!cachedScopeProbe) {
    cachedScopeProbe = (async () => {
      const result = await detectTokenScopes(transport, baseUrl, { allowSelfSignedTls });
      return result.kind === "unknown" ? "unknown" : "known";
    })();
  }
  return cachedScopeProbe;
}

/** Reset the cached GHE token and scope-probe result. Called from validate-/setActiveConfig and tests. */
export function resetAlertsRuntime(): void {
  cachedToken = null;
  cachedScopeProbe = null;
}

function parseOwnerRepo(repoFullName: string): { owner: string; repo: string } | null {
  const slash = repoFullName.indexOf("/");
  if (slash <= 0 || slash === repoFullName.length - 1) return null;
  return { owner: repoFullName.slice(0, slash), repo: repoFullName.slice(slash + 1) };
}

/**
 * Fetches one alert by category + number and returns it as a redacted
 * NormalizedIssue. Backs the plugin's `getIssue` for alert externalIds so the
 * host only ever receives the mapper's redacted clone (FR-043, NFR-012). The
 * REST base URL is derived from the active GHE instance; the transport injects
 * `allowSelfSignedTls` per-call, matching `fetchRepoAlerts`.
 */
export async function fetchSingleAlertAsIssue(
  repoFullName: string,
  category: AlertCategory,
  alertNumber: number,
): Promise<NormalizedIssue> {
  const parsed = parseOwnerRepo(repoFullName);
  if (!parsed) {
    throw new Error(`[ghe] invalid repo "${repoFullName}" for alert fetch`);
  }
  const baseUrl = buildBaseUrl(getActiveConfig().instance);
  const transport = await getTransport();
  const args = { baseUrl, owner: parsed.owner, repo: parsed.repo, alertNumber };

  switch (category) {
    case "code-scanning": {
      const raw = await fetchCodeScanningAlert(transport, args);
      return mapCodeScanningAlertToNormalizedIssue(INTEGRATION_ID, repoFullName, raw);
    }
    case "secret-scanning": {
      const raw = await fetchSecretScanningAlert(transport, args);
      return mapSecretScanningAlertToNormalizedIssue(INTEGRATION_ID, repoFullName, raw);
    }
    case "dependabot": {
      const raw = await fetchDependabotAlert(transport, args);
      return mapDependabotAlertToNormalizedIssue(INTEGRATION_ID, repoFullName, raw);
    }
  }
}

/**
 * Fetch every category enabled in `flags` for a single repo. The three
 * fetchers run in parallel; a per-category failure becomes a warning and
 * does not affect the others. Returns mapped NormalizedIssues concatenated
 * in fixed order: code-scanning, secret-scanning, dependabot.
 */
export async function fetchRepoAlerts(
  repoFullName: string,
  flags: AlertFlags,
): Promise<FetchRepoAlertsResult> {
  const enabled =
    flags.includeCodeQLAlerts === true ||
    flags.includeSecretScanningAlerts === true ||
    flags.includeDependabotAlerts === true;
  if (!enabled) {
    return { items: [], warnings: [] };
  }

  const parsed = parseOwnerRepo(repoFullName);
  if (!parsed) {
    return { items: [], warnings: [] };
  }
  const { owner, repo } = parsed;

  const config = getActiveConfig();
  const baseUrl = buildBaseUrl(config.instance);
  const transport = await getTransport();
  const fetchArgs = { baseUrl, owner, repo };

  const [codeRes, secretRes, depRes] = await Promise.all([
    flags.includeCodeQLAlerts === true
      ? safeFetchAlerts("code-scanning", () => fetchCodeScanningAlerts(transport, fetchArgs))
      : Promise.resolve(null),
    flags.includeSecretScanningAlerts === true
      ? safeFetchAlerts("secret-scanning", () => fetchSecretScanningAlerts(transport, fetchArgs))
      : Promise.resolve(null),
    flags.includeDependabotAlerts === true
      ? safeFetchAlerts("dependabot", () => fetchDependabotAlerts(transport, fetchArgs))
      : Promise.resolve(null),
  ]);

  const items: NormalizedIssue[] = [];
  const warnings: FetchRepoAlertsResult["warnings"] = [];

  const pushWarning = (
    category: "code-scanning" | "secret-scanning" | "dependabot",
    res: { cause: string; status?: number; code?: string; missingScope?: string },
  ): void => {
    const detail: NonNullable<ListIssuesWarning["detail"]> = {};
    if (res.status !== undefined) detail.status = res.status;
    if (res.missingScope !== undefined) detail.missingScope = res.missingScope;
    warnings.push({
      category,
      cause: res.cause,
      ...(res.code !== undefined
        ? { code: res.code as FetchRepoAlertsResult["warnings"][number]["code"] }
        : {}),
      ...(Object.keys(detail).length > 0 ? { detail } : {}),
    });
  };

  if (codeRes) {
    if (codeRes.ok) {
      for (const raw of codeRes.items) {
        items.push(mapCodeScanningAlertToNormalizedIssue(INTEGRATION_ID, repoFullName, raw));
      }
    } else {
      pushWarning("code-scanning", codeRes);
    }
  }
  if (secretRes) {
    if (secretRes.ok) {
      for (const raw of secretRes.items) {
        items.push(mapSecretScanningAlertToNormalizedIssue(INTEGRATION_ID, repoFullName, raw));
      }
    } else {
      pushWarning("secret-scanning", secretRes);
    }
  }
  if (depRes) {
    if (depRes.ok) {
      for (const raw of depRes.items) {
        items.push(mapDependabotAlertToNormalizedIssue(INTEGRATION_ID, repoFullName, raw));
      }
    } else {
      pushWarning("dependabot", depRes);
    }
  }

  // NFR-015: if any category came back as `missing-scope` (HTTP 401), probe
  // the token shape once. Fine-grained PATs do not emit `X-OAuth-Scopes`,
  // so we cannot honestly say `security_events` is missing; rewrite to a
  // graceful "verify scopes" variant instead.
  if (warnings.some((w) => w.code === "missing-scope")) {
    const shape = await probeTokenShape(transport, baseUrl, config.allowSelfSignedTls === true);
    if (shape === "unknown") {
      for (const w of warnings) {
        if (w.code === "missing-scope") {
          w.code = "scope-unverifiable";
          w.cause = SCOPE_UNVERIFIABLE_CAUSE;
          if (w.detail?.missingScope !== undefined) {
            delete w.detail.missingScope;
            if (Object.keys(w.detail).length === 0) {
              delete w.detail;
            }
          }
        }
      }
    }
  }

  return { items, warnings };
}
