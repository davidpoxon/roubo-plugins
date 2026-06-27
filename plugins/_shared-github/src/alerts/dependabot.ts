import { fetchSingleAlert, paginateAlerts, type PaginateOptions } from "../pagination.js";
import type { FetchTransport } from "../transport.js";
import {
  clampPerPage,
  trimTrailingSlash,
  type FetchAlertsArgs,
  type GetAlertArgs,
} from "./code-scanning.js";

/**
 * Subset of the GitHub Dependabot alert REST payload.
 *
 * Ref: https://docs.github.com/en/rest/dependabot/alerts#list-dependabot-alerts-for-a-repository
 */
export interface RawDependabotAlert {
  number: number;
  html_url: string;
  state: string;
  created_at: string;
  updated_at?: string | null;
  dependency?: {
    package?: { ecosystem?: string; name?: string };
    manifest_path?: string;
    scope?: string | null;
  };
  security_advisory?: {
    ghsa_id?: string;
    cve_id?: string | null;
    summary?: string;
    severity?: string;
  };
  security_vulnerability?: {
    severity?: string;
    package?: { ecosystem?: string; name?: string };
    first_patched_version?: { identifier?: string } | null;
  };
  [key: string]: unknown;
}

export async function fetchDependabotAlerts(
  transport: FetchTransport,
  args: FetchAlertsArgs,
  options: PaginateOptions = {},
): Promise<RawDependabotAlert[]> {
  const perPage = clampPerPage(args.perPage);
  // The Dependabot alerts endpoint rejects the `page` query param with a 400
  // ("Pagination using the `page` parameter is not supported."); unlike
  // code-scanning and secret-scanning it paginates by cursor only. Omit `page`
  // and let paginateAlerts walk the cursor-based `Link: rel="next"` chain.
  const url = `${trimTrailingSlash(args.baseUrl)}/repos/${args.owner}/${args.repo}/dependabot/alerts?state=open&per_page=${perPage}`;
  return paginateAlerts<RawDependabotAlert>(transport, url, {
    ...options,
    init: {
      ...(options.init ?? {}),
      allowSelfSignedTls: args.allowSelfSignedTls ?? options.init?.allowSelfSignedTls,
    },
  });
}

/** Fetches a single Dependabot alert by number. */
export async function fetchDependabotAlert(
  transport: FetchTransport,
  args: GetAlertArgs,
  options: PaginateOptions = {},
): Promise<RawDependabotAlert> {
  const url = `${trimTrailingSlash(args.baseUrl)}/repos/${args.owner}/${args.repo}/dependabot/alerts/${args.alertNumber}`;
  return fetchSingleAlert<RawDependabotAlert>(transport, url, {
    ...options,
    init: {
      ...(options.init ?? {}),
      allowSelfSignedTls: args.allowSelfSignedTls ?? options.init?.allowSelfSignedTls,
    },
  });
}
