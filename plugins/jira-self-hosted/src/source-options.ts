import { jiraFetch, type JiraRequestContext } from "./jira-client.js";
import { assertProjectKey, jqlSearchTerm } from "./jql.js";
import type {
  GetSourceOptionsParams,
  SourceCandidateItem,
  SourceOptionsResult,
} from "@roubo/plugin-sdk";

/**
 * Scoped, paginated, type-ahead source search (WU-002). This is the
 * generalization of `getFacetOptions` with a parent `scope` and an opaque
 * `cursor`: it serves the four discoverable categories (project, board, filter,
 * epic) through server-side search endpoints, replacing the instance-wide
 * loaders that used to live in `source-picker.ts` (no board fan-out, no 50-epic
 * cap, no unpaginated favourites). Every page is reachable via the cursor and no
 * page is dropped or duplicated (NFR-004).
 */

/** Page size requested per category page. */
export const SOURCE_OPTIONS_PAGE_SIZE = 25;

interface CursorState {
  // Single-stream categories (project, filter, epic) carry one offset.
  startAt?: number;
  // Board fans out one request per scoped project, so it tracks a per-project
  // offset. A project drops out of this map once its stream is exhausted, so a
  // continuation request never re-fetches (and thus never duplicates) it.
  perProject?: Record<string, number>;
}

export function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64");
}

export function decodeCursor(cursor: string | null | undefined): CursorState {
  if (cursor === null || cursor === undefined || cursor.length === 0) return {};
  try {
    const json = Buffer.from(cursor, "base64").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (parsed !== null && typeof parsed === "object") return parsed as CursorState;
  } catch {
    // Malformed cursor decodes to an empty state (startAt 0), never an
    // unbounded scan (security: cursors are server-encoded and validated here).
  }
  return {};
}

/**
 * Compute the next absolute `startAt` for a single Jira pagination stream, or
 * `null` when the stream is exhausted. Prefers the bean's `isLast`/`total` when
 * present and falls back to the short-page heuristic otherwise.
 */
function nextStartAt(args: {
  isLast?: boolean;
  total?: number;
  startAt: number;
  returned: number;
  pageSize: number;
}): number | null {
  const { isLast, total, startAt, returned, pageSize } = args;
  if (returned === 0) return null;
  if (isLast === true) return null;
  const consumed = startAt + returned;
  if (typeof total === "number") return consumed >= total ? null : consumed;
  return returned < pageSize ? null : consumed;
}

/** Validate and return the scoped project keys (rejects malformed keys). */
function scopedProjectKeys(params: GetSourceOptionsParams): string[] {
  const raw = params.scope?.project ?? [];
  return raw
    .filter((k): k is string => typeof k === "string" && k.length > 0)
    .map(assertProjectKey);
}

export async function getSourceOptions(
  ctx: JiraRequestContext,
  params: GetSourceOptionsParams,
): Promise<SourceOptionsResult> {
  switch (params.category) {
    case "project":
      return searchProjects(ctx, params);
    case "board":
      return searchBoards(ctx, params);
    case "filter":
      return searchFilters(ctx, params);
    case "epic":
      return searchEpics(ctx, params);
    default:
      return { items: [], nextCursor: null };
  }
}

interface ProjectListItem {
  key?: string;
  name?: string;
}

async function searchProjects(
  ctx: JiraRequestContext,
  params: GetSourceOptionsParams,
): Promise<SourceOptionsResult> {
  // Jira Data Center does not implement the paginated `/rest/api/2/project/search`
  // resource (that is Jira Cloud / newer-only); on DC it 404s because `search` is
  // parsed as a project key. The universally available endpoint is
  // `/rest/api/2/project`, which returns every visible project in a single array
  // with no server-side `query` or pagination. We therefore filter by `search`
  // and paginate client-side to preserve the type-ahead + cursor contract the
  // host's dropdown expects. Project is the root scope, so `scope` is ignored.
  const { startAt = 0 } = decodeCursor(params.cursor);
  const data = await jiraFetch<ProjectListItem[]>(ctx, "/rest/api/2/project");
  const all = Array.isArray(data) ? data : [];
  const term = (params.search ?? "").trim().toLowerCase();
  const matched = all
    .filter((p): p is { key: string; name?: string } => typeof p.key === "string")
    .filter(
      (p) =>
        term.length === 0 ||
        p.key.toLowerCase().includes(term) ||
        (p.name ?? "").toLowerCase().includes(term),
    )
    // Stable, name-then-key ordering so client-side slicing yields the same
    // page boundaries across cursor continuations (NFR-004: no dropped or
    // duplicated rows). Mirrors the name-sorted default of `/project/search`.
    .sort((a, b) => (a.name ?? a.key).localeCompare(b.name ?? b.key) || a.key.localeCompare(b.key));

  const page = matched.slice(startAt, startAt + SOURCE_OPTIONS_PAGE_SIZE);
  const items: SourceCandidateItem[] = page.map((p) => ({
    externalId: p.key,
    label: p.name ?? p.key,
    sublabel: p.key,
    icon: "project",
  }));
  const consumed = startAt + page.length;
  const nextCursor = consumed < matched.length ? encodeCursor({ startAt: consumed }) : null;
  return { items, nextCursor };
}

interface BoardSearchResponse {
  values?: Array<{ id?: number | string; name?: string; type?: string }>;
  total?: number;
  isLast?: boolean;
}

async function searchBoards(
  ctx: JiraRequestContext,
  params: GetSourceOptionsParams,
): Promise<SourceOptionsResult> {
  const projectKeys = scopedProjectKeys(params);
  if (projectKeys.length === 0) return { items: [], nextCursor: null };

  const decoded = decodeCursor(params.cursor);
  const isContinuation = params.cursor != null && decoded.perProject !== undefined;
  const perProject = decoded.perProject ?? {};
  // First page: search every scoped project. Continuation: only the projects
  // still present in the cursor (exhausted ones were dropped last time).
  const activeKeys = isContinuation ? projectKeys.filter((k) => k in perProject) : projectKeys;

  const items: SourceCandidateItem[] = [];
  const nextPerProject: Record<string, number> = {};
  for (const key of activeKeys) {
    const startAt = isContinuation ? (perProject[key] ?? 0) : 0;
    const data = await jiraFetch<BoardSearchResponse>(ctx, "/rest/agile/1.0/board", {
      query: {
        projectKeyOrId: key,
        name: emptyToUndefined(params.search),
        startAt,
        maxResults: SOURCE_OPTIONS_PAGE_SIZE,
      },
    });
    const values = data.values ?? [];
    for (const board of values) {
      if (board.id === undefined) continue;
      const type =
        typeof board.type === "string" && board.type.length > 0 ? ` · ${board.type}` : "";
      items.push({
        externalId: `board:${board.id}`,
        label: String(board.name ?? `Board ${board.id}`),
        sublabel: `${key} · board #${board.id}${type}`,
        icon: "board",
      });
    }
    const next = nextStartAt({
      isLast: data.isLast,
      total: data.total,
      startAt,
      returned: values.length,
      pageSize: SOURCE_OPTIONS_PAGE_SIZE,
    });
    if (next !== null) nextPerProject[key] = next;
  }

  const nextCursor =
    Object.keys(nextPerProject).length > 0 ? encodeCursor({ perProject: nextPerProject }) : null;
  return { items, nextCursor };
}

interface FavouriteFilter {
  id?: number | string;
  name?: string;
  owner?: { displayName?: string };
}

async function searchFilters(
  ctx: JiraRequestContext,
  params: GetSourceOptionsParams,
): Promise<SourceOptionsResult> {
  // Honor the project-first cascade gate. Jira Data Center has no general
  // paginated filter-search resource (`/rest/api/2/filter/search` is Cloud-only
  // and 404s on DC, see #469), so we list the user's favourite filters via
  // `/rest/api/2/filter/favourite` and filter + paginate by name client-side,
  // mirroring `searchProjects`. Favourites are the signed-in user's, not
  // project-scoped, so the project gate only controls when the Filters control
  // is revealed (it does not narrow the favourites list). Filter `owner` is
  // appended to the sublabel only when the instance returns it.
  const projectKeys = scopedProjectKeys(params);
  if (projectKeys.length === 0) return { items: [], nextCursor: null };

  const { startAt = 0 } = decodeCursor(params.cursor);
  const data = await jiraFetch<FavouriteFilter[]>(ctx, "/rest/api/2/filter/favourite");
  const all = Array.isArray(data) ? data : [];
  const term = (params.search ?? "").trim().toLowerCase();
  const matched = all
    .filter(
      (f): f is { id: number | string; name?: string; owner?: { displayName?: string } } =>
        f !== null && typeof f === "object" && f.id !== undefined,
    )
    .filter((f) => term.length === 0 || (f.name ?? "").toLowerCase().includes(term))
    // Stable name-then-id ordering so client-side slicing yields the same page
    // boundaries across cursor continuations (NFR-004: no dropped/duplicated rows).
    .sort(
      (a, b) =>
        (a.name ?? String(a.id)).localeCompare(b.name ?? String(b.id)) ||
        String(a.id).localeCompare(String(b.id)),
    );

  const page = matched.slice(startAt, startAt + SOURCE_OPTIONS_PAGE_SIZE);
  const items: SourceCandidateItem[] = page.map((f) => {
    const owner = f.owner?.displayName;
    return {
      externalId: String(f.id),
      label: String(f.name ?? `Filter ${f.id}`),
      sublabel: owner ? `${owner} · filter #${f.id}` : `filter #${f.id}`,
      icon: "filter",
    };
  });
  const consumed = startAt + page.length;
  const nextCursor = consumed < matched.length ? encodeCursor({ startAt: consumed }) : null;
  return { items, nextCursor };
}

interface IssueSearchResponse {
  issues?: Array<{ key?: string; fields?: { summary?: string } }>;
  total?: number;
}

async function searchEpics(
  ctx: JiraRequestContext,
  params: GetSourceOptionsParams,
): Promise<SourceOptionsResult> {
  const projectKeys = scopedProjectKeys(params);
  if (projectKeys.length === 0) return { items: [], nextCursor: null };

  const { startAt = 0 } = decodeCursor(params.cursor);
  const clauses = [
    `project in (${projectKeys.join(", ")})`,
    "issuetype = Epic",
    "resolution = Unresolved",
  ];
  const term = jqlSearchTerm(params.search ?? "");
  // Skip the contains clause when the term cleaned down to nothing, so an
  // all-punctuation search does not become `summary ~ ""`.
  if (term !== '""') clauses.push(`summary ~ ${term}`);
  const jql = `${clauses.join(" AND ")} ORDER BY updated DESC`;

  const data = await jiraFetch<IssueSearchResponse>(ctx, "/rest/api/2/search", {
    method: "POST",
    body: { jql, startAt, maxResults: SOURCE_OPTIONS_PAGE_SIZE, fields: ["summary"] },
  });
  const issues = data.issues ?? [];
  const items: SourceCandidateItem[] = issues
    .filter((i): i is { key: string; fields?: { summary?: string } } => typeof i.key === "string")
    .map((i) => ({
      externalId: i.key,
      label: i.fields?.summary ?? i.key,
      sublabel: i.key,
      icon: "epic",
    }));
  const next = nextStartAt({
    total: data.total,
    startAt,
    returned: issues.length,
    pageSize: SOURCE_OPTIONS_PAGE_SIZE,
  });
  return { items, nextCursor: next === null ? null : encodeCursor({ startAt: next }) };
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}
