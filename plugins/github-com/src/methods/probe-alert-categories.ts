/**
 * Test Connection per-category probe (WU-041, FR-047) for github.com.
 *
 * Delegates to the `src/shared/` helper, which holds the HTTP-status mapping
 * for every alert category in one place.
 */

import type {
  FetchInit,
  FetchResult,
  ProbeAlertCategoriesParams,
  ProbeAlertCategoriesResult,
} from "@roubo/plugin-sdk";
import { probeAlertCategories as runProbe, type FetchTransport } from "../shared/index.js";
import { getHost } from "../host-binding.js";

const GITHUB_API_BASE_URL = "https://api.github.com";

export async function probeAlertCategories(
  params: ProbeAlertCategoriesParams,
): Promise<ProbeAlertCategoriesResult> {
  const host = getHost();
  const token = await host.credentials.get("github-token");

  const transport: FetchTransport = async (url: string, init?: FetchInit): Promise<FetchResult> => {
    const headers: Record<string, string> = { ...(init?.headers ?? {}) };
    if (token && !headers.Authorization && !headers.authorization) {
      headers.Authorization = `Bearer ${token}`;
    }
    return host.fetch(url, { ...init, headers });
  };

  const reports = await runProbe({
    baseUrl: GITHUB_API_BASE_URL,
    transport,
    sources: params.sources,
    enabledCategories: params.enabledCategories,
    timeoutMsPerProbe: params.timeoutMsPerProbe,
  });

  return { reports };
}
