import type {
  ListIssuesParams,
  ListIssuesResult,
  ListIssuesWarning,
  NormalizedIssue,
} from "@roubo/plugin-sdk";
import { parseAllSources, type GheSource } from "../sources.js";
import {
  decodeCompositeCursor,
  encodeCompositeCursor,
  isStatusExcluded,
} from "@roubo/shared-github";
import { formatExternalId } from "../external-id.js";
import {
  fetchBlockingRelationships,
  fetchIssuesPage,
  fetchProjectItems,
  type IssueSortField,
} from "../github-fetchers.js";
import {
  normalizeState,
  projectNodeToNormalizedIssue,
  rawToNormalizedIssue,
} from "../normalize.js";
import { fetchRepoAlerts, type AlertFlags } from "../alerts-runtime.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

function decodeRepoCursor(cursor: string | null): number {
  if (!cursor) return 1;
  const n = Number(cursor);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

function clampPageSize(size: number | undefined): number {
  if (!size || size <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(size, MAX_PAGE_SIZE);
}

/** The GHE sort fields (CLI-FR-009, from `getSortFields`); no native key sort. */
const SORT_FIELDS: ReadonlySet<IssueSortField> = new Set(["created", "updated", "comments"]);

/**
 * Map the host's `sortBy`/`sortDir` onto the GitHub REST `sort`/`direction`
 * params (CLI-FR-010). Applied source-side so order is stable across pages.
 * An unrecognised field is ignored, falling back to the API default ordering.
 */
function resolveSort(params: ListIssuesParams): {
  sort?: IssueSortField;
  direction?: "asc" | "desc";
} {
  if (typeof params.sortBy !== "string" || !SORT_FIELDS.has(params.sortBy as IssueSortField)) {
    return {};
  }
  return {
    sort: params.sortBy as IssueSortField,
    direction: params.sortDir === "asc" ? "asc" : "desc",
  };
}

function parseProjectExternalId(externalId: string): { owner: string; projectNumber: number } {
  const hashIdx = externalId.lastIndexOf("#");
  if (hashIdx === -1) {
    throw new Error(
      `[ghe] project externalId "${externalId}" missing "#<number>". Expected "owner/#1".`,
    );
  }
  const owner = externalId.slice(0, hashIdx).replace(/\/$/, "");
  const projectNumber = Number(externalId.slice(hashIdx + 1));
  if (!owner || !Number.isInteger(projectNumber) || projectNumber <= 0) {
    throw new Error(
      `[ghe] project externalId "${externalId}" not in the expected "owner/#<positive-int>" form.`,
    );
  }
  return { owner, projectNumber };
}

function alertFlagsOf(source: GheSource): AlertFlags {
  return {
    includeCodeQLAlerts: source.includeCodeQLAlerts,
    includeSecretScanningAlerts: source.includeSecretScanningAlerts,
    includeDependabotAlerts: source.includeDependabotAlerts,
  };
}

async function listFromRepo(
  repoFullName: string,
  params: ListIssuesParams,
  source: GheSource,
): Promise<ListIssuesResult> {
  const pageSize = clampPageSize(params.pageSize);
  const page = decodeRepoCursor(params.cursor);

  const labels = params.filters?.labels?.join(",");
  const search = params.filters?.search;
  const { sort, direction } = resolveSort(params);
  const fetchOpts: {
    page: number;
    perPage: number;
    labels?: string;
    search?: string;
    sort?: IssueSortField;
    direction?: "asc" | "desc";
  } = {
    page,
    perPage: pageSize,
  };
  if (labels) fetchOpts.labels = labels;
  if (search) fetchOpts.search = search;
  if (sort) {
    fetchOpts.sort = sort;
    fetchOpts.direction = direction;
  }

  const result = await fetchIssuesPage(repoFullName, fetchOpts);
  const issueNumbers = result.items.map((i) => i.number);
  const blocking = await fetchBlockingRelationships(repoFullName, issueNumbers);

  const items: NormalizedIssue[] = result.items.map((raw) =>
    rawToNormalizedIssue(raw, {
      blockedBy: (blocking.blockedBy[raw.number] ?? []).map((b) =>
        formatExternalId(repoFullName, b.number),
      ),
      blocks: (blocking.blocks[raw.number] ?? []).map((b) =>
        formatExternalId(repoFullName, b.number),
      ),
    }),
  );

  // Override externalId to fully-qualified form so cross-method calls (getIssue,
  // getComments) can recover the repo context from the ID alone.
  for (const item of items) {
    item.externalId = formatExternalId(repoFullName, Number(item.externalId));
  }

  const result_: ListIssuesResult = {
    items,
    nextCursor: result.hasNextPage ? String(page + 1) : null,
  };

  // Alerts are only fetched on page 1; the shared fetchers walk all alert
  // pages internally so subsequent issue pages would surface duplicates.
  if (page === 1) {
    const alertResult = await fetchRepoAlerts(repoFullName, alertFlagsOf(source));
    if (alertResult.items.length > 0) {
      result_.items = [...items, ...alertResult.items];
    }
    if (alertResult.warnings.length > 0) {
      result_.warnings = alertResult.warnings.map((w) => ({
        ...w,
        sourceExternalId: source.externalId,
      }));
    }
  }

  return result_;
}

async function listFromProject(
  externalId: string,
  params: ListIssuesParams,
  source: GheSource,
  allowedRepos: Set<string> | null,
): Promise<ListIssuesResult> {
  const pageSize = clampPageSize(params.pageSize);
  const { owner, projectNumber } = parseProjectExternalId(externalId);
  const page = await fetchProjectItems(owner, projectNumber);

  // A Project board can carry items from any repo (even cross-org) and in any
  // state. Restrict the cut list to OPEN issues whose repo is one of the
  // project's configured Repository sources: this matches the repo path's
  // state:"open" filter and keeps a foreign repo's issues (e.g. one parked on
  // an org board) from surfacing under an unrelated project. When the project
  // has no repo sources to scope against (a project-only config) `allowedRepos`
  // is null and the repo filter is skipped, but closed issues are still dropped.
  const repoOf = (node: (typeof page.nodes)[number]): string =>
    node.content?.repository?.nameWithOwner ?? `${owner}/unknown`;
  const scopedNodes = page.nodes.filter((node) => {
    const content = node.content;
    if (!content || !content.number) return false;
    if (content.__typename && content.__typename !== "Issue") return false;
    if (normalizeState(content.state) !== "open") return false;
    if (allowedRepos && !allowedRepos.has(repoOf(node))) return false;
    return true;
  });

  // Server-side status exclusion (issue #399): drop board items whose Projects
  // v2 "Status" column is in the host-resolved excludedStatuses list, before
  // pagination so an excluded item never occupies a result-page slot. Alerts
  // still fan out over `scopedNodes` (below), so a repo whose issues are all
  // excluded keeps surfacing its GHAS alerts.
  const visibleNodes = scopedNodes.filter(
    (node) => !isStatusExcluded(node.fieldValueByName?.name, params.excludedStatuses),
  );

  const offset = decodeRepoCursor(params.cursor) - 1;
  const pageNumber = offset + 1;
  const slice = visibleNodes.slice(offset * pageSize, (offset + 1) * pageSize);
  const hasMore = (offset + 1) * pageSize < visibleNodes.length;

  const items: NormalizedIssue[] = [];
  for (const node of slice) {
    const normalized = projectNodeToNormalizedIssue(node, `${owner}/unknown`);
    if (!normalized) continue;
    const repoFullName = repoOf(node);
    normalized.externalId = formatExternalId(repoFullName, Number(normalized.externalId));
    items.push(normalized);
  }

  const result_: ListIssuesResult = {
    items,
    nextCursor: hasMore ? String(offset + 2) : null,
  };

  // Alerts fan out across every distinct repo the project surfaces. Only on
  // page 1; see note in listFromRepo. Walk the full `scopedNodes`, not just
  // `slice`, so repos that first appear past the page-1 issue slice still
  // get their alerts pulled. Skipping them would silently hide GHAS warnings
  // for whole repos in a project that spans more than `pageSize` items.
  // `scopedNodes` is already scoped to the project's configured repos, so we
  // never fetch alerts for a foreign repo that merely shares the board. It is
  // deliberately the pre-status-exclusion set: a repo whose issues are all in
  // an excluded status still surfaces its security alerts (issue #399).
  if (pageNumber === 1) {
    const alertFlags = alertFlagsOf(source);
    const reposForAlerts = new Set<string>();
    for (const node of scopedNodes) {
      reposForAlerts.add(repoOf(node));
    }
    const perRepo = await Promise.all(
      Array.from(reposForAlerts).map((r) => fetchRepoAlerts(r, alertFlags)),
    );

    const alertItems: NormalizedIssue[] = [];
    // Dedupe warnings by (code, category, cause) across the repos the project
    // spans. N copies of "GHAS not enabled" for one project source is noise.
    // Include `code` in the key so two different codes for the same category
    // (e.g. one repo missing scope, another with GHAS off) do not collapse.
    const seenWarning = new Set<string>();
    const dedupedWarnings: ListIssuesWarning[] = [];
    for (const r of perRepo) {
      for (const w of r.items) alertItems.push(w);
      for (const w of r.warnings) {
        const key = `${w.code ?? "_"}::${w.category}::${w.cause}`;
        if (seenWarning.has(key)) continue;
        seenWarning.add(key);
        dedupedWarnings.push({ ...w, sourceExternalId: source.externalId });
      }
    }
    if (alertItems.length > 0) {
      result_.items = [...items, ...alertItems];
    }
    if (dedupedWarnings.length > 0) {
      result_.warnings = dedupedWarnings;
    }
  }

  return result_;
}

/** Dispatch one source to its kind-specific lister with a per-source cursor. */
function listFromSource(
  source: GheSource,
  params: ListIssuesParams,
  allowedRepos: Set<string> | null,
): Promise<ListIssuesResult> {
  if (source.kind === "repo") {
    return listFromRepo(source.externalId, params, source);
  }
  return listFromProject(source.externalId, params, source, allowedRepos);
}

/**
 * Aggregate the cut list across every configured source. A submodule project
 * surfaces the root repo plus each submodule (and any GitHub Projects); each is
 * paginated independently and stitched together with an opaque composite cursor
 * that carries each source's own next-page cursor.
 *
 * On the first request (`cursor == null`) every source starts at page 1, so each
 * source's own `page === 1` gate fetches its security alerts exactly once. On
 * later pages only the sources that still have a next page remain active, and no
 * source ever returns to page 1, so alerts are never re-fetched. Item order is
 * stable: sources in host order (root first, then submodules), and within each
 * source issues precede its code-scanning/secret-scanning/dependabot alerts.
 * Cross-source duplicates are collapsed by the host's (integrationId,
 * externalId) dedup.
 */
export async function listIssues(params: ListIssuesParams): Promise<ListIssuesResult> {
  const sources = parseAllSources(params.sources);
  // The repo allow-list scopes Project-board issues to this project's own repos
  // (see listFromProject). null = no repo sources configured, so board scoping
  // is left off rather than blanking a project-only board.
  const repoExternalIds = sources.filter((s) => s.kind === "repo").map((s) => s.externalId);
  const allowedRepos = repoExternalIds.length > 0 ? new Set(repoExternalIds) : null;
  const isFirstPage = params.cursor == null;
  const cursorBySource = isFirstPage ? {} : decodeCompositeCursor(params.cursor as string);

  const active = isFirstPage
    ? sources
    : sources.filter((s) => cursorBySource[s.externalId] != null);

  const perSource = await Promise.allSettled(
    active.map((s) =>
      listFromSource(
        s,
        {
          ...params,
          cursor: isFirstPage ? null : (cursorBySource[s.externalId] ?? null),
        },
        allowedRepos,
      ),
    ),
  );

  const items: NormalizedIssue[] = [];
  const warnings: ListIssuesWarning[] = [];
  const nextBySource: Record<string, string> = {};
  active.forEach((s, i) => {
    const settled = perSource[i];
    // One source failing must not blank the whole cut list. With Promise.all a
    // transient error on a single submodule (a 5xx, rate-limit, or missing repo
    // from fetchIssuesPage) would reject the entire page and suppress every
    // other source's issues AND security alerts: the exact regression this
    // branch exists to fix. Aggregate what succeeded, surface a per-source
    // warning for what failed, and carry the failed source's prior cursor
    // forward so it is retried on the next page rather than silently dropped
    // from pagination. A source that keeps failing once it is the only one left
    // echoes back its own cursor, which the host's stall detection collapses to
    // end-of-list, so this cannot loop forever.
    if (settled.status === "rejected") {
      const priorCursor = isFirstPage ? null : (cursorBySource[s.externalId] ?? null);
      if (priorCursor != null) nextBySource[s.externalId] = priorCursor;
      warnings.push({
        category: "issues",
        sourceExternalId: s.externalId,
        cause: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
        code: "unknown",
      });
      return;
    }
    const result = settled.value;
    items.push(...result.items);
    if (result.warnings) warnings.push(...result.warnings);
    if (result.nextCursor != null) nextBySource[s.externalId] = result.nextCursor;
  });

  const out: ListIssuesResult = {
    items,
    nextCursor: Object.keys(nextBySource).length > 0 ? encodeCompositeCursor(nextBySource) : null,
  };
  if (warnings.length > 0) out.warnings = warnings;
  return out;
}
