/**
 * Non-throwing wrapper around the per-category alert fetchers.
 *
 * The GitHub plugins must surface per-category fetch failures as warnings on
 * the listIssues envelope (FR-046), not as exceptions. This helper turns an
 * `AlertPaginationError` (status-bearing, thrown by `paginateAlerts`) into a
 * structured `{ ok: false, cause, status }` shape with a category-specific
 * cause string per the HTTP-code mapping table in WU-030.
 *
 * The cause strings are part of the user-facing contract: AC #5 fixes the
 * 404 / code-scanning string and AC #6 fixes the 451 / secret-scanning
 * string byte-for-byte. Do not edit casually.
 */

import { AlertPaginationError } from "../pagination.js";

export type AlertFetchCategory = "code-scanning" | "secret-scanning" | "dependabot";

/**
 * Discriminator the client uses to pick chip variants for the cut-list
 * source picker. Mirrors `ListIssuesWarningCode` in `@roubo/plugin-sdk`,
 * intentionally duplicated here so this package has no dep on the SDK.
 */
export type SafeFetchWarningCode =
  | "missing-scope"
  | "feature-disabled"
  | "insufficient-permission"
  | "not-found"
  | "rate-limited"
  | "unknown";

export type SafeFetchResult<T> =
  | { ok: true; items: T[] }
  | {
      ok: false;
      cause: string;
      status?: number;
      code: SafeFetchWarningCode;
      missingScope?: string;
    };

const CATEGORY_PREFIX: Record<AlertFetchCategory, string> = {
  "code-scanning": "Code Scanning",
  "secret-scanning": "Secret Scanning",
  dependabot: "Dependabot alerts",
};

type CauseTable = Record<AlertFetchCategory, Partial<Record<number, string>>>;

const CAUSE_TABLE: CauseTable = {
  "code-scanning": {
    401: "Code Scanning unavailable: missing security_events scope on the GitHub token.",
    403: "Code Scanning unavailable: token lacks permission to read code-scanning alerts on this repo.",
    404: "Code Scanning unavailable: GHAS not enabled on this repo.",
    410: "Code Scanning unavailable: endpoint has been removed for this repo.",
    451: "Code Scanning unavailable: requires GitHub Advanced Security on private repos.",
  },
  "secret-scanning": {
    401: "Secret Scanning unavailable: missing repo or security_events scope on the GitHub token.",
    403: "Secret Scanning unavailable: token lacks permission to read secret-scanning alerts on this repo.",
    404: "Secret Scanning unavailable: not enabled on this repo.",
    410: "Secret Scanning unavailable: endpoint has been removed for this repo.",
    451: "Secret Scanning unavailable: requires GitHub Advanced Security on private repos.",
  },
  dependabot: {
    401: "Dependabot alerts unavailable: missing security_events scope on the GitHub token.",
    403: "Dependabot alerts unavailable: token lacks permission to read dependabot alerts on this repo.",
    404: "Dependabot alerts unavailable: not enabled on this repo.",
    410: "Dependabot alerts unavailable: endpoint has been removed for this repo.",
    451: "Dependabot alerts unavailable: requires GitHub Advanced Security on private repos.",
  },
};

function classifyStatus(status: number): SafeFetchWarningCode {
  if (status === 401) return "missing-scope";
  if (status === 403) return "insufficient-permission";
  if (status === 404) return "not-found";
  if (status === 410 || status === 451) return "feature-disabled";
  if (status === 429) return "rate-limited";
  return "unknown";
}

export async function safeFetchAlerts<T>(
  category: AlertFetchCategory,
  run: () => Promise<T[]>,
): Promise<SafeFetchResult<T>> {
  try {
    const items = await run();
    return { ok: true, items };
  } catch (err) {
    if (err instanceof AlertPaginationError) {
      const mapped = CAUSE_TABLE[category][err.status];
      const cause =
        mapped ?? `${CATEGORY_PREFIX[category]} unavailable: GitHub returned HTTP ${err.status}.`;
      const code = classifyStatus(err.status);
      const missingScope = err.status === 401 ? "security_events" : undefined;
      return {
        ok: false,
        cause,
        status: err.status,
        code,
        ...(missingScope !== undefined ? { missingScope } : {}),
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      cause: `${CATEGORY_PREFIX[category]} unavailable: ${message}`,
      code: "unknown",
    };
  }
}
