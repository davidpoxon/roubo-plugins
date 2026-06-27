import { fetchSingleAlert, paginateAlerts, type PaginateOptions } from "../pagination.js";
import type { FetchTransport } from "../transport.js";
import {
  clampPerPage,
  trimTrailingSlash,
  type FetchAlertsArgs,
  type GetAlertArgs,
} from "./code-scanning.js";

/**
 * Subset of the GitHub Secret Scanning alert REST payload. The `secret` field
 * holds the literal token surfaced by the scanner; the redaction helpers strip
 * it before the alert is ever placed in `NormalizedIssue.raw` (FR-043, NFR-012).
 *
 * Ref: https://docs.github.com/en/rest/secret-scanning/secret-scanning#list-secret-scanning-alerts-for-a-repository
 */
export interface RawSecretScanningAlert {
  number: number;
  html_url: string;
  state: string;
  created_at: string;
  updated_at?: string | null;
  secret_type?: string;
  secret_type_display_name?: string;
  secret?: string;
  resolution?: string | null;
  push_protection_bypassed?: boolean | null;
  validity?: string | null;
  [key: string]: unknown;
}

export async function fetchSecretScanningAlerts(
  transport: FetchTransport,
  args: FetchAlertsArgs,
  options: PaginateOptions = {},
): Promise<RawSecretScanningAlert[]> {
  const perPage = clampPerPage(args.perPage);
  const url = `${trimTrailingSlash(args.baseUrl)}/repos/${args.owner}/${args.repo}/secret-scanning/alerts?state=open&per_page=${perPage}&page=1`;
  return paginateAlerts<RawSecretScanningAlert>(transport, url, {
    ...options,
    init: {
      ...(options.init ?? {}),
      allowSelfSignedTls: args.allowSelfSignedTls ?? options.init?.allowSelfSignedTls,
    },
  });
}

/**
 * Fetches a single Secret Scanning alert by number. The literal secret is
 * stripped by the mapper's redaction before the alert reaches any host-visible
 * surface (FR-043, NFR-012); this fetcher returns the raw API payload, so its
 * result must always be passed through `mapSecretScanningAlertToNormalizedIssue`.
 */
export async function fetchSecretScanningAlert(
  transport: FetchTransport,
  args: GetAlertArgs,
  options: PaginateOptions = {},
): Promise<RawSecretScanningAlert> {
  const url = `${trimTrailingSlash(args.baseUrl)}/repos/${args.owner}/${args.repo}/secret-scanning/alerts/${args.alertNumber}`;
  return fetchSingleAlert<RawSecretScanningAlert>(transport, url, {
    ...options,
    init: {
      ...(options.init ?? {}),
      allowSelfSignedTls: args.allowSelfSignedTls ?? options.init?.allowSelfSignedTls,
    },
  });
}
