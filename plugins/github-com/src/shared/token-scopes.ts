import type { FetchInit } from "@roubo/plugin-sdk";
import type { FetchTransport } from "./transport.js";

/**
 * Result of probing the token's OAuth scopes via `GET {baseUrl}/user`.
 *
 *   - `scopes`: the `X-OAuth-Scopes` header was present and parsed (an empty
 *     array is a valid result; the header was sent but listed no scopes).
 *   - `unknown`: the response did not include `X-OAuth-Scopes` at all. GitHub
 *     does not emit this header for fine-grained PATs or GitHub App installation
 *     tokens, so callers must surface graceful copy rather than asserting
 *     "scope missing".
 *   - `error`: the probe call itself failed (non-2xx or transport threw). The
 *     `status` and `detail` are safe to surface; `detail` never contains the
 *     bearer token.
 *
 * The `scopes` and `unknown` variants also carry the authenticated account's
 * `login` when it could be parsed from the `GET /user` body (the same request
 * that reads the scopes header). It is omitted when the body is missing,
 * unparseable, or carries no `login`; callers must treat it as best-effort.
 */
export type DetectTokenScopesResult =
  | { kind: "scopes"; scopes: string[]; login?: string }
  | { kind: "unknown"; login?: string }
  | { kind: "error"; status?: number; detail: string };

export interface DetectTokenScopesOptions {
  headers?: Record<string, string>;
  allowSelfSignedTls?: boolean;
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function getHeader(
  headers: Record<string, string | string[]>,
  name: string,
): string | string[] | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

function parseScopesHeader(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const joined = Array.isArray(value) ? value.join(",") : value;
  return joined
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Best-effort extraction of the authenticated account's `login` from the
// `GET /user` body. Never throws: a missing, non-JSON, or login-less body
// yields `undefined` so the scopes probe stays the source of truth.
function parseLogin(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { login?: unknown };
    return typeof parsed.login === "string" && parsed.login.length > 0 ? parsed.login : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Probes `GET {baseUrl}/user` to read the token's granted OAuth scopes from the
 * `X-OAuth-Scopes` response header. The caller's transport is responsible for
 * injecting authentication (e.g. `Authorization: Bearer <token>`); this helper
 * never sees the bearer token directly so it cannot leak it through error
 * strings or logs.
 *
 * Caching is intentionally NOT performed here. The host already caches
 * `getConnectionStatus` (plugin-manager.ts), which is the correct layer.
 */
export async function detectTokenScopes(
  transport: FetchTransport,
  baseUrl: string,
  options: DetectTokenScopesOptions = {},
): Promise<DetectTokenScopesResult> {
  const url = `${trimTrailingSlash(baseUrl)}/user`;
  const init: FetchInit = {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers ?? {}),
    },
    ...(options.allowSelfSignedTls ? { allowSelfSignedTls: true } : {}),
  };

  let res;
  try {
    res = await transport(url, init);
  } catch (err) {
    return { kind: "error", detail: (err as Error).message };
  }

  if (res.status < 200 || res.status >= 300) {
    return {
      kind: "error",
      status: res.status,
      detail: `GET ${url} returned status ${res.status}`,
    };
  }

  const login = parseLogin(res.body);
  const scopes = parseScopesHeader(getHeader(res.headers, "X-OAuth-Scopes"));
  if (scopes === undefined) return { kind: "unknown", login };
  return { kind: "scopes", scopes, login };
}

/**
 * Convenience predicate. Returns `true` only when scopes were observed AND
 * include `scope`. `unknown` and `error` results return `false` because we
 * cannot assert the scope is granted; callers wanting "definitely lacking"
 * should distinguish those kinds explicitly.
 */
export function hasScope(result: DetectTokenScopesResult, scope: string): boolean {
  return result.kind === "scopes" && result.scopes.includes(scope);
}

/**
 * Three-way scope assertion. Returns:
 *   - `granted` when scopes are observed and include `scope`.
 *   - `lacking` when scopes are observed and do NOT include `scope`.
 *   - `unknown` when no `X-OAuth-Scopes` header was returned (fine-grained PAT
 *     or GitHub App installation token) or the probe errored.
 */
export function scopeStatus(
  result: DetectTokenScopesResult,
  scope: string,
): "granted" | "lacking" | "unknown" {
  if (result.kind === "scopes") return result.scopes.includes(scope) ? "granted" : "lacking";
  return "unknown";
}

/** The OAuth scope GitHub requires to read Code Scanning, Secret Scanning, and Dependabot alerts. */
export const SECURITY_EVENTS_SCOPE = "security_events";
