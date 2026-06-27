// Ports of the read-only fetchers in server/services/github.ts. Helper bodies,
// GraphQL queries, cache keys, and pagination caps mirror the legacy module so
// downstream parity tests (TC-042, TC-043) and behaviour under load match.

import {
  CACHE_TTL,
  blockingCache,
  githubRequest,
  issueCache,
  issueTypesCache,
  parseRepo,
  projectCache,
  projectItemCache,
  pruneCache,
} from "./github-request.js";
import { flattenBlockers, openBlocks } from "./normalize.js";
import type {
  BlockingRelationshipsResponse,
  BlockingRelationshipsResult,
  IssueTypeNode,
  IssueTypesResponse,
  ProjectItemsResponse,
  ProjectV2Data,
  ProjectsResponse,
  RawComment,
  RawIssue,
  RawRepo,
  RawUser,
  SearchIssuesResult,
} from "./types.js";

/** GitHub REST `sort` values the cut-list sort picker offers (CLI-FR-009). */
export type IssueSortField = "created" | "updated" | "comments";

interface ListIssuesOptions {
  labels?: string;
  search?: string;
  page?: number;
  perPage?: number;
  /**
   * Source-side sort (CLI-FR-010). Maps directly onto the GitHub REST `sort` /
   * `direction` params so the order is stable across pages (the API paginates
   * the sorted set). Defaults to `updated` / `desc`, the prior behaviour.
   */
  sort?: IssueSortField;
  direction?: "asc" | "desc";
}

interface ListIssuesPage {
  items: RawIssue[];
  hasNextPage: boolean;
}

export async function fetchIssuesPage(
  repoFullName: string,
  options: ListIssuesOptions = {},
): Promise<ListIssuesPage> {
  const page = options.page ?? 1;
  const perPage = Math.min(Math.max(options.perPage ?? 50, 1), 100);
  const sort: IssueSortField = options.sort ?? "updated";
  const direction: "asc" | "desc" = options.direction ?? "desc";
  // Sort/direction participate in the cache key: a different ordering is a
  // different first page, so a sort change must not serve a stale cached page.
  const cacheKey = `${repoFullName}:${options.labels ?? ""}:${options.search ?? ""}:p=${page}:s=${perPage}:sort=${sort}:dir=${direction}`;
  const cached = issueCache.get(cacheKey) as
    | { data: ListIssuesPage; timestamp: number }
    | undefined;
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const { owner, repo } = parseRepo(repoFullName);

  let items: RawIssue[];
  let rawPageSize: number;

  if (options.search) {
    const q = `repo:${repoFullName} is:issue is:open ${options.search}`;
    const result = await githubRequest<SearchIssuesResult>({
      kind: "rest",
      route: "GET /search/issues",
      // The search API shares the cut-list sort vocabulary (created/updated/
      // comments) but names the direction param `order` (CLI-FR-010).
      params: { q, per_page: perPage, page, sort, order: direction },
    });
    rawPageSize = result.data.items.length;
    items = result.data.items.filter((item) => !item.pull_request);
  } else {
    const params: Record<string, unknown> = {
      owner,
      repo,
      state: "open",
      per_page: perPage,
      page,
      sort,
      direction,
    };
    if (options.labels) params.labels = options.labels;
    const result = await githubRequest<RawIssue[]>({
      kind: "rest",
      route: "GET /repos/{owner}/{repo}/issues",
      params,
    });
    rawPageSize = result.data.length;
    items = result.data.filter((item) => !item.pull_request);
  }

  // hasNextPage must be computed from the unfiltered API response length:
  // `/issues` returns issues AND PRs interleaved, so a full page with PRs
  // mixed in would otherwise short-circuit pagination after PR filtering.
  const data: ListIssuesPage = { items, hasNextPage: rawPageSize === perPage };
  issueCache.set(cacheKey, { data, timestamp: Date.now() });
  pruneCache(issueCache);
  return data;
}

export async function fetchIssueDetail(
  repoFullName: string,
  issueNumber: number,
): Promise<RawIssue> {
  const { owner, repo } = parseRepo(repoFullName);
  const result = await githubRequest<RawIssue>({
    kind: "rest",
    route: "GET /repos/{owner}/{repo}/issues/{issue_number}",
    params: { owner, repo, issue_number: issueNumber },
  });
  return result.data;
}

export async function fetchIssueComments(
  repoFullName: string,
  issueNumber: number,
): Promise<RawComment[]> {
  const { owner, repo } = parseRepo(repoFullName);
  const result = await githubRequest<RawComment[]>({
    kind: "rest",
    route: "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
    params: { owner, repo, issue_number: issueNumber, per_page: 100 },
  });
  return result.data;
}

export async function fetchLabels(repoFullName: string): Promise<string[]> {
  const { owner, repo } = parseRepo(repoFullName);
  const result = await githubRequest<Array<{ name: string }>>({
    kind: "rest",
    route: "GET /repos/{owner}/{repo}/labels",
    params: { owner, repo, per_page: 100 },
  });
  return result.data.map((l) => l.name);
}

export async function fetchMilestones(repoFullName: string): Promise<string[]> {
  const { owner, repo } = parseRepo(repoFullName);
  const result = await githubRequest<Array<{ title: string }>>({
    kind: "rest",
    route: "GET /repos/{owner}/{repo}/milestones",
    // Only open milestones populate the facet so stale closed milestones do not clutter the options.
    params: { owner, repo, per_page: 100, state: "open" },
  });
  return result.data.map((m) => m.title);
}

export async function fetchAssignees(repoFullName: string): Promise<string[]> {
  const { owner, repo } = parseRepo(repoFullName);
  const result = await githubRequest<Array<{ login: string }>>({
    kind: "rest",
    route: "GET /repos/{owner}/{repo}/assignees",
    params: { owner, repo, per_page: 100 },
  });
  return result.data.map((a) => a.login);
}

// ── Blocking relationships ──

const BLOCKING_BATCH_SIZE = 20;

function buildBlockingQuery(issueNumbers: number[]): string {
  const issueAliases = issueNumbers
    .map(
      (n) => `
    issue_${n}: issue(number: ${n}) {
      blockedBy(first: 10) {
        nodes {
          ... on Issue {
            number title state
            blockedBy(first: 10) {
              nodes {
                ... on Issue {
                  number title state
                  blockedBy(first: 10) {
                    nodes {
                      ... on Issue { number title state }
                    }
                  }
                }
              }
            }
          }
        }
      }
      blocking(first: 100) {
        nodes {
          ... on Issue { number title state }
        }
        pageInfo { hasNextPage }
      }
    }`,
    )
    .join("");

  return `query($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {${issueAliases}
    }
  }`;
}

export async function fetchBlockingRelationships(
  repoFullName: string,
  issueNumbers: number[],
): Promise<BlockingRelationshipsResult> {
  if (issueNumbers.length === 0) return { blockedBy: {}, blocks: {} };

  const sortedNumbers = [...issueNumbers].sort((a, b) => a - b);
  const cacheKey = `${repoFullName}:${sortedNumbers.join(",")}`;
  const cached = blockingCache.get(cacheKey) as
    | { data: BlockingRelationshipsResult; timestamp: number }
    | undefined;
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const { owner, repo } = parseRepo(repoFullName);
  const blockedBy: Record<number, Array<{ number: number; title: string }>> = {};
  const blocks: Record<number, Array<{ number: number; title: string }>> = {};

  try {
    // Process in batches to stay within GraphQL query complexity limits
    for (let i = 0; i < sortedNumbers.length; i += BLOCKING_BATCH_SIZE) {
      const batch = sortedNumbers.slice(i, i + BLOCKING_BATCH_SIZE);
      const query = buildBlockingQuery(batch);
      const result = await githubRequest<BlockingRelationshipsResponse>({
        kind: "graphql",
        query,
        variables: { owner, repo },
        opName: "blockingRelationships",
      });
      for (const issueNumber of batch) {
        const issueData = result.data.repository[`issue_${issueNumber}`];
        if (!issueData) {
          blockedBy[issueNumber] = [];
          blocks[issueNumber] = [];
          continue;
        }
        blockedBy[issueNumber] = flattenBlockers(issueData.blockedBy.nodes, 3, new Set());
        blocks[issueNumber] = openBlocks(issueData.blocking.nodes);
        if (issueData.blocking.pageInfo.hasNextPage) {
          console.warn(
            `[github] issue #${issueNumber} blocks more than 100 issues; list is truncated`,
          );
        }
      }
    }
  } catch (err) {
    console.warn(
      "[github] fetchBlockingRelationships failed, returning empty results:",
      (err as Error).message,
    );
    for (const n of sortedNumbers) {
      if (!blockedBy[n]) blockedBy[n] = [];
      if (!blocks[n]) blocks[n] = [];
    }
  }

  const result: BlockingRelationshipsResult = { blockedBy, blocks };
  blockingCache.set(cacheKey, { data: result, timestamp: Date.now() });
  pruneCache(blockingCache);
  return result;
}

// ── GitHub Projects v2 ──

export interface ProjectSummary {
  number: number;
  title: string;
}

export async function fetchProjects(owner: string): Promise<ProjectSummary[]> {
  const cached = projectCache.get(owner) as
    | { data: ProjectSummary[]; timestamp: number }
    | undefined;
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const orgQuery = `query($owner: String!) {
    organization(login: $owner) {
      projectsV2(first: 50, orderBy: {field: TITLE, direction: ASC}) {
        nodes { number title }
      }
    }
  }`;

  const userQuery = `query($owner: String!) {
    user(login: $owner) {
      projectsV2(first: 50, orderBy: {field: TITLE, direction: ASC}) {
        nodes { number title }
      }
    }
  }`;

  let projects: ProjectSummary[];

  try {
    const result = await githubRequest<ProjectsResponse>({
      kind: "graphql",
      query: orgQuery,
      variables: { owner },
    });
    projects = (result.data.organization?.projectsV2.nodes ?? []).map((n) => ({
      number: n.number,
      title: n.title,
    }));
  } catch {
    const result = await githubRequest<ProjectsResponse>({
      kind: "graphql",
      query: userQuery,
      variables: { owner },
    });
    projects = (result.data.user?.projectsV2.nodes ?? []).map((n) => ({
      number: n.number,
      title: n.title,
    }));
  }

  projectCache.set(owner, { data: projects, timestamp: Date.now() });
  pruneCache(projectCache);
  return projects;
}

const projectItemsQuery = `query($owner: String!, $projectNumber: Int!, $cursor: String) {
  organization(login: $owner) {
    projectV2(number: $projectNumber) {
      title
      items(first: 50, after: $cursor) {
        nodes {
          content {
            __typename
            ... on Issue {
              number title body state
              repository { nameWithOwner }
              labels(first: 20) { nodes { name } }
              assignees(first: 5) { nodes { login } }
              milestone { title }
              issueType { name }
              createdAt updatedAt
              comments { totalCount }
              url
            }
          }
          fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const projectItemsUserQuery = `query($owner: String!, $projectNumber: Int!, $cursor: String) {
  user(login: $owner) {
    projectV2(number: $projectNumber) {
      title
      items(first: 50, after: $cursor) {
        nodes {
          content {
            __typename
            ... on Issue {
              number title body state
              repository { nameWithOwner }
              labels(first: 20) { nodes { name } }
              assignees(first: 5) { nodes { login } }
              milestone { title }
              issueType { name }
              createdAt updatedAt
              comments { totalCount }
              url
            }
          }
          fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

export interface ProjectItemsPage {
  title: string;
  nodes: ProjectV2Data["items"]["nodes"];
}

export async function fetchProjectItems(
  ownerOrRepoFullName: string,
  projectNumber: number,
): Promise<ProjectItemsPage> {
  const owner = ownerOrRepoFullName.includes("/")
    ? parseRepo(ownerOrRepoFullName).owner
    : ownerOrRepoFullName;

  const cacheKey = `${owner}:${projectNumber}`;
  const cached = projectItemCache.get(cacheKey) as
    | { data: ProjectItemsPage; timestamp: number }
    | undefined;
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const MAX_PAGES = 10;
  const allNodes: ProjectV2Data["items"]["nodes"] = [];
  let projectTitle = "";
  let cursor: string | null = null;
  let useOrgQuery: boolean | null = null;
  let lastPageHadMore = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    let projectData: ProjectV2Data;

    if (useOrgQuery === null) {
      try {
        const result = await githubRequest<ProjectItemsResponse>({
          kind: "graphql",
          query: projectItemsQuery,
          variables: { owner, projectNumber, cursor },
        });
        projectData = (
          result.data.organization as NonNullable<ProjectItemsResponse["organization"]>
        ).projectV2;
        useOrgQuery = true;
      } catch {
        const result = await githubRequest<ProjectItemsResponse>({
          kind: "graphql",
          query: projectItemsUserQuery,
          variables: { owner, projectNumber, cursor },
        });
        projectData = (result.data.user as NonNullable<ProjectItemsResponse["user"]>).projectV2;
        useOrgQuery = false;
      }
    } else {
      const query = useOrgQuery ? projectItemsQuery : projectItemsUserQuery;
      const result = await githubRequest<ProjectItemsResponse>({
        kind: "graphql",
        query,
        variables: { owner, projectNumber, cursor },
      });
      projectData = useOrgQuery
        ? (result.data.organization as NonNullable<ProjectItemsResponse["organization"]>).projectV2
        : (result.data.user as NonNullable<ProjectItemsResponse["user"]>).projectV2;
    }

    projectTitle = projectData.title;
    allNodes.push(...projectData.items.nodes);

    lastPageHadMore = projectData.items.pageInfo.hasNextPage;
    if (!lastPageHadMore) break;
    cursor = projectData.items.pageInfo.endCursor;
  }

  if (lastPageHadMore) {
    console.warn(
      `[github] fetchProjectItems for ${owner} project #${projectNumber}: ` +
        `hit pagination limit of ${MAX_PAGES} pages; some items may be missing`,
    );
  }

  const data: ProjectItemsPage = { title: projectTitle, nodes: allNodes };
  projectItemCache.set(cacheKey, { data, timestamp: Date.now() });
  pruneCache(projectItemCache);
  return data;
}

// ── Issue types ──

const ISSUE_TYPES_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    issueTypes(first: 50) {
      nodes { id name description color isEnabled }
      pageInfo { hasNextPage }
    }
  }
}`;

export interface IssueTypeResult {
  configured: boolean;
  types: Array<{ id: string; name: string; description?: string; color?: string }>;
}

export async function fetchIssueTypes(repoFullName: string): Promise<IssueTypeResult> {
  const cached = issueTypesCache.get(repoFullName) as
    | { data: IssueTypeResult; timestamp: number }
    | undefined;
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const { owner, repo } = parseRepo(repoFullName);

  const r = await githubRequest<IssueTypesResponse>({
    kind: "graphql",
    query: ISSUE_TYPES_QUERY,
    variables: { owner, name: repo },
    opName: "fetchIssueTypes",
  });
  const issueTypes = r.data.repository?.issueTypes;
  const nodes: IssueTypeNode[] = issueTypes?.nodes ?? [];
  if (issueTypes?.pageInfo.hasNextPage) {
    console.warn(
      `[github] fetchIssueTypes: ${repoFullName} has more than 50 issue types; only the first 50 were fetched`,
    );
  }

  const enabled = nodes.filter((n) => n.isEnabled);
  const result: IssueTypeResult =
    enabled.length === 0
      ? { configured: false, types: [] }
      : {
          configured: true,
          types: enabled.map((n) => ({
            id: n.id,
            name: n.name,
            ...(n.description != null ? { description: n.description } : {}),
            ...(n.color != null ? { color: n.color } : {}),
          })),
        };

  issueTypesCache.set(repoFullName, { data: result, timestamp: Date.now() });
  pruneCache(issueTypesCache);
  return result;
}

// ── Current user + repos ──

export async function fetchCurrentUser(): Promise<RawUser> {
  const result = await githubRequest<RawUser>({
    kind: "rest",
    route: "GET /user",
  });
  return result.data;
}

// `/user/repos` is paginated at 100/page; a user with more accessible repos than
// one page would otherwise have the tail silently dropped (and the dropped repos'
// owners missed for project enumeration). Walk pages until a short page, capped so
// a pathological account can't loop unbounded.
const USER_REPOS_PER_PAGE = 100;
const USER_REPOS_MAX_PAGES = 10;

export async function fetchUserRepos(): Promise<RawRepo[]> {
  const all: RawRepo[] = [];
  for (let page = 1; page <= USER_REPOS_MAX_PAGES; page++) {
    const result = await githubRequest<RawRepo[]>({
      kind: "rest",
      route: "GET /user/repos",
      params: {
        affiliation: "owner,collaborator,organization_member",
        per_page: USER_REPOS_PER_PAGE,
        sort: "updated",
        direction: "desc",
        page,
      },
    });
    all.push(...result.data);
    if (result.data.length < USER_REPOS_PER_PAGE) return all;
  }
  console.warn(
    `[github] fetchUserRepos: stopped after ${USER_REPOS_MAX_PAGES} pages (${all.length} repos); additional repos were not fetched`,
  );
  return all;
}

export async function fetchRepoSummary(repoFullName: string): Promise<RawRepo> {
  const { owner, repo } = parseRepo(repoFullName);
  const result = await githubRequest<RawRepo>({
    kind: "rest",
    route: "GET /repos/{owner}/{repo}",
    params: { owner, repo },
  });
  return result.data;
}
