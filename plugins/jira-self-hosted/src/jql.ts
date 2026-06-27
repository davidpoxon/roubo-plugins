/**
 * JQL builder for point-in-time cut-list queries.
 *
 * Every call to `listIssues` fetches the current state of the configured
 * sources, matching the contract of the GitHub/GHE plugins. There is no
 * accumulating issue store, so an incremental delta model would only hide
 * issues after the first poll. `ORDER BY updated ASC` is kept so `startAt`
 * offset pagination is deterministic within a single multi-page walk.
 *
 * Source kinds (FR-004/FR-007/FR-008): `filter` and `epic` map straight to a
 * JQL clause; `project` scopes to a single project key; `board` is resolved to
 * its active-sprint / whole-board clause at list time (`board-resolve.ts`) and
 * arrives here pre-resolved on `SourceClause.resolvedClause`. `mine` ("assigned
 * to me") is a narrowing filter: it is AND-ed across the union of the other
 * sources (rather than OR-ed into it) so it restricts which matching issues are
 * shown rather than adding a new independent cut-list. This mirrors how
 * `statusCategory not in (...)` is already handled as a top-level AND.
 */

export type SourceKind = "filter" | "epic" | "project" | "board" | "mine";

export interface SourceClause {
  kind: SourceKind;
  externalId: string;
  /**
   * `board` only: the JQL clause produced by `board-resolve.ts` at list time
   * (active sprint or whole-board backing filter). An empty/absent value means
   * the board could not be resolved and the clause is dropped from the union.
   */
  resolvedClause?: string;
  /** `board` only: which mode produced `resolvedClause` (active-sprint vs whole-board). */
  boardMode?: "active-sprint" | "whole-board";
  /** `mine` only: in-scoped-projects vs anywhere. */
  mineScope?: "in-project" | "anywhere";
  /** `mine` only: the in-scope project keys to narrow `in-project` mode by. */
  scopeProjectKeys?: string[];
}

export interface BuildJqlInput {
  sources: SourceClause[];
  /**
   * Category-first status exclusion (FR-009/FR-010). When the instance supports
   * `statusCategory` in JQL (the default), a non-empty list emits a top-level
   * `statusCategory not in (...)` clause ANDed across the whole union so
   * excluded issues never occupy a result page.
   */
  excludedStatusCategories?: string[];
  /**
   * Status-name fallback list. Only consulted when `statusCategorySupported` is
   * false (the instance rejected `statusCategory`): emits `status not in (...)`
   * instead. Ignored on the supported path so the default behaviour is exactly
   * "exclude the configured categories" (TC-037).
   */
  excludedStatuses?: string[];
  /**
   * Whether the target instance accepts `statusCategory` in JQL. Defaults to
   * true; the plugin flips it to false (per instance) after a `statusCategory`
   * JQL parse error and rebuilds with the name list.
   */
  statusCategorySupported?: boolean;
  /**
   * Cut-list sort selection (CLI-FR-009/CLI-FR-010). `sortBy` is one of the
   * fields this plugin declares via `getSortFields` (key/updated/created/
   * priority); `sortDir` is the direction. Emitted as the JQL `ORDER BY` tail
   * so the order is stable across the `startAt` pagination walk. Absent (or an
   * unrecognised field) falls back to the deterministic `updated ASC` default.
   */
  sortBy?: string;
  sortDir?: "asc" | "desc";
}

/**
 * The JQL columns this plugin offers in the sort picker (CLI-FR-009, Spike
 * 554 / #554), mapped to their JQL field name. `key` is the native issue-key
 * sort (CLI-FR-014 makes key-ascending the host fallback; Jira can sort by it
 * source-side, so it is offered here). `rank` is instance-conditional and is
 * deferred (see the plugin summary for #584).
 */
const JQL_SORT_FIELDS: Readonly<Record<string, string>> = {
  key: "key",
  updated: "updated",
  created: "created",
  priority: "priority",
};

/**
 * The sort fields this plugin declares to the host (CLI-FR-009). Order is the
 * order shown in the picker. `key` defaults to ascending (the conventional
 * issue-key order, matching the host fallback CLI-FR-014); the date and
 * priority fields default to descending (newest / highest first).
 */
export const JIRA_SORT_FIELDS: ReadonlyArray<{
  id: string;
  label: string;
  defaultDir: "asc" | "desc";
}> = [
  { id: "key", label: "Key", defaultDir: "asc" },
  { id: "updated", label: "Updated", defaultDir: "desc" },
  { id: "created", label: "Created", defaultDir: "desc" },
  { id: "priority", label: "Priority", defaultDir: "desc" },
];

/** Resolve the `ORDER BY` tail from the requested sort, or the safe default. */
function buildOrderBy(sortBy: string | undefined, sortDir: "asc" | "desc" | undefined): string {
  const column = sortBy ? JQL_SORT_FIELDS[sortBy] : undefined;
  if (!column) return "ORDER BY updated ASC";
  const dir = sortDir === "desc" ? "DESC" : "ASC";
  return `ORDER BY ${column} ${dir}`;
}

export function buildIssueListJql({
  sources,
  excludedStatusCategories,
  excludedStatuses,
  statusCategorySupported = true,
  sortBy,
  sortDir,
}: BuildJqlInput): string {
  // `mine` is a narrowing filter, not an additional cut-list: it must be
  // AND-ed across the union of the other sources, not OR-ed into it.
  // Partition up-front so the OR join never sees the assignee clause.
  const orSources = sources.filter((s) => s.kind !== "mine");
  const mineSources = sources.filter((s) => s.kind === "mine");

  // Drop empty clauses (e.g. an unresolvable board) before the OR join so the
  // union never degenerates into `( OR ...)`.
  const parts = orSources.map(toClause).filter((part) => part.length > 0);
  const sourceClause = parts.length === 0 ? "" : `(${parts.join(" OR ")})`;

  const mineParts = mineSources.map(toClause).filter((part) => part.length > 0);
  const mineClause = mineParts.length === 0 ? "" : `(${mineParts.join(" AND ")})`;

  const exclusionClause = buildExclusionClause(
    excludedStatusCategories,
    excludedStatuses,
    statusCategorySupported,
  );

  const where = [sourceClause, mineClause, exclusionClause]
    .filter((part) => part.length > 0)
    .join(" AND ");
  const tail = buildOrderBy(sortBy, sortDir);
  return where.length > 0 ? `${where} ${tail}` : tail;
}

/**
 * Build the top-level status-exclusion clause (FR-009/FR-010). Category-first:
 * on the supported path emit `statusCategory not in (...)` from the category
 * list and ignore the name list; on the fallback path (instance rejected
 * `statusCategory`) emit `status not in (...)` from the resolved name list.
 * Returns "" when the active list is empty so the AND-join drops it.
 */
function buildExclusionClause(
  categories: string[] | undefined,
  statuses: string[] | undefined,
  statusCategorySupported: boolean,
): string {
  if (statusCategorySupported) {
    const list = (categories ?? []).filter((c) => c.length > 0);
    if (list.length === 0) return "";
    return `statusCategory not in (${list.map(jqlString).join(", ")})`;
  }
  const list = (statuses ?? []).filter((s) => s.length > 0);
  if (list.length === 0) return "";
  return `status not in (${list.map(jqlString).join(", ")})`;
}

function toClause(source: SourceClause): string {
  switch (source.kind) {
    case "filter":
      return `filter = ${jqlNumericOrQuoted(source.externalId)}`;
    case "epic":
      return `"Epic Link" = ${jqlString(source.externalId)}`;
    case "project":
      return `project = ${jqlString(source.externalId)}`;
    case "board":
      // Resolved upstream at list time; an unresolved board contributes nothing.
      return source.resolvedClause ?? "";
    case "mine": {
      const keys = source.scopeProjectKeys ?? [];
      if (source.mineScope === "in-project" && keys.length > 0) {
        const list = keys.map(jqlString).join(", ");
        return `(assignee = currentUser() AND project in (${list}))`;
      }
      return "assignee = currentUser()";
    }
  }
}

export function jqlNumericOrQuoted(value: string): string {
  if (/^[0-9]+$/.test(value)) return value;
  return jqlString(value);
}

function jqlString(value: string): string {
  // Escape backslashes first, then double quotes, so an input like `\"` can't
  // smuggle in an unescaped quote. JQL string literals use C-style escapes.
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** Upper bound on a user-typed search term before it is interpolated into JQL. */
const SEARCH_TERM_MAX_LENGTH = 100;

// JQL text-operator / wildcard hazards. The `~` (contains) operator gives these
// boolean/wildcard meaning, so they are neutralized before interpolation.
const JQL_TEXT_HAZARDS = /[+\-&|!(){}[\]^~*?:]/g;

/**
 * Drop ASCII control characters (code points below 0x20 and DEL) so they can
 * never affect the quoted literal. Done by code point rather than a regex to
 * keep the source free of literal control bytes.
 */
function stripControlChars(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
  }
  return out;
}

/**
 * Escape a user-typed search term for safe interpolation into a JQL text match
 * (e.g. `summary ~ <jqlSearchTerm(term)>`). Beyond the backslash/quote escaping
 * `jqlString` does, the `~` (contains) operator gives meaning to wildcard and
 * boolean characters (`* ? + - & | ! ( ) { } [ ] ^ ~ :`), so they are
 * neutralized to spaces; the term is also length-bounded. Returns a fully
 * quoted JQL string literal (NFR-003: a crafted term cannot break out of the
 * quoted literal or inject a clause).
 */
export function jqlSearchTerm(raw: string): string {
  const bounded = String(raw ?? "").slice(0, SEARCH_TERM_MAX_LENGTH);
  const cleaned = stripControlChars(bounded)
    .replace(JQL_TEXT_HAZARDS, " ")
    .replace(/\s+/g, " ")
    .trim();
  return jqlString(cleaned);
}

/**
 * Validate a Jira project key for safe interpolation. A project key is never
 * free text, so an invalid one is rejected (not escaped): the source-options
 * search scopes `project in (...)` / `projectKeyOrId=` on these keys, and a
 * strict regex guarantees no injection surface. Returns the key on success.
 */
export function assertProjectKey(raw: string): string {
  if (typeof raw !== "string" || !/^[A-Z][A-Z0-9_]+$/.test(raw)) {
    throw new Error(`Invalid Jira project key: ${JSON.stringify(raw)}`);
  }
  return raw;
}
