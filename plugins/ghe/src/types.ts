// Raw shapes returned by the GitHub REST/GraphQL APIs. Mirror the internal
// types in server/services/github.ts so the verbatim githubRequest helper and
// the mappers continue to type-check unchanged.

export interface RawIssue {
  number: number;
  title: string;
  body?: string | null;
  state?: string;
  labels?: Array<{ name?: string } | string>;
  assignee?: { login: string } | null;
  assignees?: Array<{ login: string } | null> | null;
  milestone?: { title: string } | null;
  user?: { login: string } | null;
  type?: { name: string } | null;
  created_at: string;
  updated_at: string;
  comments?: number;
  html_url: string;
  pull_request?: unknown;
}

export interface RawComment {
  id: number;
  body?: string | null;
  user?: { login: string } | null;
  created_at: string;
  updated_at?: string;
}

export interface RawRepo {
  name: string;
  full_name: string;
  description?: string | null;
  private?: boolean;
}

export interface RawUser {
  id: number;
  login: string;
  name?: string | null;
}

export interface SearchIssuesResult {
  total_count?: number;
  incomplete_results?: boolean;
  items: RawIssue[];
}

// ── GraphQL response shapes ──

export interface ProjectsResponse {
  organization?: { projectsV2: { nodes: Array<{ number: number; title: string }> } };
  user?: { projectsV2: { nodes: Array<{ number: number; title: string }> } };
}

export interface BlockedByNode {
  number: number;
  title: string;
  state: string;
  blockedBy?: { nodes: BlockedByNode[] };
}

export interface BlockingNode {
  number: number;
  title: string;
  state: string;
}

export interface BlockingRelationshipsResponse {
  repository: Record<
    string,
    | {
        blockedBy: { nodes: BlockedByNode[] };
        blocking: { nodes: BlockingNode[]; pageInfo: { hasNextPage: boolean } };
      }
    | null
    | undefined
  >;
}

export interface BlockingRelationshipsResult {
  blockedBy: Record<number, Array<{ number: number; title: string }>>;
  blocks: Record<number, Array<{ number: number; title: string }>>;
}

export interface IssueTypeNode {
  id: string;
  name: string;
  description?: string | null;
  color?: string | null;
  isEnabled: boolean;
}

export interface IssueTypesResponse {
  repository?: {
    issueTypes?: {
      nodes: IssueTypeNode[];
      pageInfo: { hasNextPage: boolean };
    } | null;
  } | null;
}

export interface ProjectV2Data {
  title: string;
  items: {
    nodes: Array<{
      content: {
        __typename?: string;
        number?: number;
        title?: string;
        body?: string | null;
        state?: string;
        labels?: { nodes: Array<{ name: string }> };
        assignees?: { nodes: Array<{ login: string }> };
        milestone?: { title: string } | null;
        issueType?: { name: string } | null;
        createdAt?: string;
        updatedAt?: string;
        comments?: { totalCount: number };
        url?: string;
        repository?: { nameWithOwner: string };
      } | null;
      fieldValueByName: { name: string } | null;
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export interface ProjectItemsResponse {
  organization?: { projectV2: ProjectV2Data };
  user?: { projectV2: ProjectV2Data };
}

// ── Plugin config shape ──
//
// Plugin-wide config: the GHE instance URL and an optional self-signed-TLS
// toggle. Source selection is supplied per-call via the `sources` field on
// each source-bound method's params (listIssues, listIssueTypes, listLabels),
// so the plugin process holds no per-project state.

export interface PluginConfig {
  instance: string;
  allowSelfSignedTls: boolean;
}
