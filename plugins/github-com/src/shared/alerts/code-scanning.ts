import { fetchSingleAlert, paginateAlerts, type PaginateOptions } from "../pagination.js";
import type { FetchTransport } from "../transport.js";

/**
 * Subset of the GitHub Code Scanning alert REST payload the bundled plugins
 * consume. Other fields the API returns are preserved into `raw` after
 * redaction; only the ones surfaced through the NormalizedIssue mapper are
 * typed here.
 *
 * Ref: https://docs.github.com/en/rest/code-scanning/alerts#list-code-scanning-alerts-for-a-repository
 */
export interface RawCodeScanningAlert {
  number: number;
  html_url: string;
  state: string;
  created_at: string;
  updated_at?: string | null;
  rule?: {
    id?: string;
    name?: string;
    description?: string;
    severity?: string;
    security_severity_level?: string;
  };
  tool?: { name?: string; version?: string | null };
  most_recent_instance?: {
    ref?: string;
    state?: string;
    commit_sha?: string;
    location?: CodeScanningLocation;
    message?: { text?: string };
  };
  instances?: Array<{ location?: CodeScanningLocation }>;
  [key: string]: unknown;
}

export interface CodeScanningLocation {
  path?: string;
  start_line?: number;
  end_line?: number;
  start_column?: number;
  end_column?: number;
  snippet?: string;
  [key: string]: unknown;
}

export interface FetchAlertsArgs {
  baseUrl: string;
  owner: string;
  repo: string;
  perPage?: number;
  allowSelfSignedTls?: boolean;
}

/** Args for fetching a single alert by its per-repo alert number. */
export interface GetAlertArgs {
  baseUrl: string;
  owner: string;
  repo: string;
  alertNumber: number;
  allowSelfSignedTls?: boolean;
}

export async function fetchCodeScanningAlerts(
  transport: FetchTransport,
  args: FetchAlertsArgs,
  options: PaginateOptions = {},
): Promise<RawCodeScanningAlert[]> {
  const perPage = clampPerPage(args.perPage);
  const url = `${trimTrailingSlash(args.baseUrl)}/repos/${args.owner}/${args.repo}/code-scanning/alerts?state=open&per_page=${perPage}&page=1`;
  return paginateAlerts<RawCodeScanningAlert>(transport, url, {
    ...options,
    init: {
      ...(options.init ?? {}),
      allowSelfSignedTls: args.allowSelfSignedTls ?? options.init?.allowSelfSignedTls,
    },
  });
}

/**
 * Fetches a single Code Scanning alert by number. Used by the host's
 * bench-assignment path (via the plugin's `getIssue`) to hydrate redacted
 * alert detail without paginating the whole listing.
 */
export async function fetchCodeScanningAlert(
  transport: FetchTransport,
  args: GetAlertArgs,
  options: PaginateOptions = {},
): Promise<RawCodeScanningAlert> {
  const url = `${trimTrailingSlash(args.baseUrl)}/repos/${args.owner}/${args.repo}/code-scanning/alerts/${args.alertNumber}`;
  return fetchSingleAlert<RawCodeScanningAlert>(transport, url, {
    ...options,
    init: {
      ...(options.init ?? {}),
      allowSelfSignedTls: args.allowSelfSignedTls ?? options.init?.allowSelfSignedTls,
    },
  });
}

export function clampPerPage(perPage: number | undefined): number {
  const n = perPage ?? 50;
  if (!Number.isInteger(n) || n < 1) return 1;
  if (n > 100) return 100;
  return n;
}

export function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
