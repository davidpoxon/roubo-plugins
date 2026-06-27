import { host } from "@roubo/plugin-sdk";
import type { FetchInit, FetchResult } from "@roubo/plugin-sdk";

export interface JiraFetchOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

export interface JiraRequestContext {
  instance: string;
  pat: string;
  /**
   * When true, the host's TLS agent uses `rejectUnauthorized: false` for every
   * request, so an on-prem Jira behind a self-signed or internal-CA cert is
   * reachable. Off by default; the user opts in per-instance via the Configure
   * dialog's "Allow self-signed TLS" toggle (FR-009).
   */
  allowSelfSignedTls?: boolean;
}

export class JiraApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "JiraApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * True when an error is Jira rejecting a JQL query because it does not
 * understand the `statusCategory` field (DC versions that predate it). Jira
 * returns HTTP 400 with a JQL-parse message naming the field; we match that to
 * trigger the status-name fallback in `listIssues` (TC-037). We check both the
 * raw 400 body and the formatted message so it works regardless of which Jira
 * surfaced the field name.
 */
export function isStatusCategoryUnsupportedError(err: unknown): boolean {
  if (!(err instanceof JiraApiError) || err.status !== 400) return false;
  return /statuscategory/i.test(`${err.body} ${err.message}`);
}

/**
 * Thin wrapper over `host.fetch`. Joins paths to the configured instance
 * URL, attaches the PAT, and turns non-2xx responses into structured
 * errors that surface Jira's own message verbatim (TC-063 relies on this
 * for the transition-permission edge case).
 */
export async function jiraFetch<T = unknown>(
  ctx: JiraRequestContext,
  path: string,
  options: JiraFetchOptions = {},
): Promise<T> {
  const url = buildUrl(ctx.instance, path, options.query);
  const init: FetchInit = {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${ctx.pat}`,
      Accept: "application/json",
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
  };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }
  if (ctx.allowSelfSignedTls) {
    init.allowSelfSignedTls = true;
  }

  let result: FetchResult;
  try {
    result = await host.fetch(url, init);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new JiraApiError(`Network call to Jira failed: ${message}`, 0, "");
  }

  if (result.status < 200 || result.status >= 300) {
    throw new JiraApiError(formatJiraError(result), result.status, result.body);
  }

  // Empty body on 204 No Content.
  if (result.body === "") return undefined as T;

  try {
    return JSON.parse(result.body) as T;
  } catch {
    throw new JiraApiError(
      `Jira returned non-JSON response from ${path}`,
      result.status,
      result.body,
    );
  }
}

function buildUrl(
  instance: string,
  path: string,
  query: Record<string, string | number | undefined> | undefined,
): string {
  const instanceHost = new URL(instance).host;
  // Defense-in-depth: the manifest's network allowlist must be `**` because the
  // instance host is user-supplied and unknown at authoring time. Every internal
  // caller passes an instance-relative path; reject an absolute URL that points
  // off-instance so a future caller cannot reach an unintended host. The host
  // now also enforces this at the `host.fetch` boundary (#338, constraining `**`
  // to the configured instance host); this check stays as a second layer.
  if (/^https?:\/\//i.test(path)) {
    const absolute = new URL(path);
    if (absolute.host !== instanceHost) {
      throw new JiraApiError(
        `Refusing to call ${absolute.host}: requests must stay on the configured Jira instance ${instanceHost}.`,
        0,
        "",
      );
    }
  }
  // Concatenate (rather than `new URL(path, instance)`) so an instance served
  // under a context path (e.g. https://host/jira) keeps that prefix.
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${instance}${normalizedPath}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function formatJiraError(result: FetchResult): string {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    // Fall through to the raw body when Jira returns HTML or empty bodies.
  }

  if (parsed && typeof parsed === "object") {
    const obj = parsed as { errorMessages?: unknown; errors?: unknown };
    if (Array.isArray(obj.errorMessages) && obj.errorMessages.length > 0) {
      return String(obj.errorMessages[0]);
    }
    if (obj.errors && typeof obj.errors === "object") {
      const first = Object.values(obj.errors as Record<string, unknown>)[0];
      if (typeof first === "string" && first.length > 0) return first;
    }
  }

  if (result.body.trim().length > 0) {
    return `Jira responded with HTTP ${result.status}: ${result.body.slice(0, 200)}`;
  }
  return `Jira responded with HTTP ${result.status}`;
}
