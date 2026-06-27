/**
 * Test Connection per-category probe (WU-041, FR-047) for GitHub Enterprise.
 *
 * Delegates to the shared `_shared-github` helper so the github.com and GHE
 * plugins behave identically; the only differences are the base URL (built
 * from the active GHE instance) and the optional self-signed TLS opt-in.
 */

import type {
  FetchInit,
  FetchResult,
  ProbeAlertCategoriesParams,
  ProbeAlertCategoriesResult,
} from "@roubo/plugin-sdk";
import { probeAlertCategories as runProbe, type FetchTransport } from "@roubo/shared-github";
import { tryGetActiveConfig } from "../active-config.js";
import { getHost } from "../host-binding.js";

function buildBaseUrl(instance: string): string {
  return `${instance.replace(/\/$/, "")}/api/v3`;
}

export async function probeAlertCategories(
  params: ProbeAlertCategoriesParams,
): Promise<ProbeAlertCategoriesResult> {
  const config = tryGetActiveConfig();
  if (!config) {
    return {
      reports: params.enabledCategories.map((category) => ({
        category,
        status: "error" as const,
        detail:
          "No active GHE configuration. The host must call validateConfig (with at least { instance }) before probeAlertCategories.",
      })),
    };
  }

  const host = getHost();
  const token = await host.credentials.get("token");

  const transport: FetchTransport = async (url: string, init?: FetchInit): Promise<FetchResult> => {
    const headers: Record<string, string> = { ...(init?.headers ?? {}) };
    if (token && !headers.Authorization && !headers.authorization) {
      headers.Authorization = `Bearer ${token}`;
    }
    return host.fetch(url, { ...init, headers });
  };

  const reports = await runProbe({
    baseUrl: buildBaseUrl(config.instance),
    transport,
    sources: params.sources,
    enabledCategories: params.enabledCategories,
    timeoutMsPerProbe: params.timeoutMsPerProbe,
    allowSelfSignedTls: config.allowSelfSignedTls,
  });

  return { reports };
}
