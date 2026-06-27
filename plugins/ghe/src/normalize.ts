import type { NormalizedComment, NormalizedIssue } from "@roubo/plugin-sdk";
import type { BlockedByNode, BlockingNode, ProjectV2Data, RawComment, RawIssue } from "./types.js";

export const INTEGRATION_ID = "ghe";

/** Lowercases GitHub's "open"/"closed" issue state for downstream consumers. */
export function normalizeState(state: string | undefined): string {
  return (state ?? "open").toLowerCase();
}

function transitionsForState(state: string): string[] {
  return normalizeState(state) === "open" ? ["close"] : ["reopen"];
}

function assigneeList(raw: RawIssue): NormalizedIssue["assignees"] {
  const out: NormalizedIssue["assignees"] = [];
  if (raw.assignees && raw.assignees.length > 0) {
    for (const a of raw.assignees) {
      if (!a) continue;
      out.push({ externalId: a.login, displayName: a.login });
    }
    return out;
  }
  if (raw.assignee) {
    out.push({ externalId: raw.assignee.login, displayName: raw.assignee.login });
  }
  return out;
}

function labelList(raw: RawIssue): string[] {
  return (raw.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? "")));
}

export interface NormalizeIssueOptions {
  blockedBy?: string[];
  blocks?: string[];
}

/**
 * Maps the GitHub REST RawIssue shape to the host-facing NormalizedIssue
 * contract. `blockedBy` / `blocks` are passed in by the caller after a
 * batched GraphQL lookup; the mapper itself is stateless.
 */
export function rawToNormalizedIssue(
  raw: RawIssue,
  options: NormalizeIssueOptions = {},
): NormalizedIssue {
  const state = normalizeState(raw.state);
  return {
    integrationId: INTEGRATION_ID,
    externalId: String(raw.number),
    externalUrl: raw.html_url,
    title: raw.title,
    body: raw.body ?? null,
    currentState: state,
    allowedTransitions: transitionsForState(state),
    assignees: assigneeList(raw),
    labels: labelList(raw),
    issueType: raw.type?.name ?? null,
    blocks: options.blocks ?? [],
    blockedBy: options.blockedBy ?? [],
    updatedAt: raw.updated_at,
    raw,
  };
}

export function rawToNormalizedComment(raw: RawComment): NormalizedComment {
  const login = raw.user?.login ?? "unknown";
  return {
    externalId: String(raw.id),
    author: { externalId: login, displayName: login },
    body: raw.body ?? "",
    createdAt: raw.created_at,
    updatedAt: raw.updated_at ?? raw.created_at,
  };
}

/**
 * Maps a GitHub Projects v2 item node into a NormalizedIssue. Returns null
 * for non-issue content (PRs, draft issues) or items missing a number, so
 * callers can filter them out before returning to the host.
 */
export function projectNodeToNormalizedIssue(
  node: ProjectV2Data["items"]["nodes"][number],
  defaultRepoFullName: string,
): NormalizedIssue | null {
  const content = node.content;
  if (!content || !content.number) return null;
  if (content.__typename && content.__typename !== "Issue") return null;

  const state = normalizeState(content.state);
  const repoFullName = content.repository?.nameWithOwner ?? defaultRepoFullName;
  const externalUrl = content.url ?? `https://github.com/${repoFullName}/issues/${content.number}`;
  const assignees = (content.assignees?.nodes ?? []).map((a) => ({
    externalId: a.login,
    displayName: a.login,
  }));

  const raw: RawIssue = {
    number: content.number,
    title: content.title ?? "",
    body: content.body ?? null,
    state,
    labels: (content.labels?.nodes ?? []).map((l) => ({ name: l.name })),
    assignee: content.assignees?.nodes?.[0] ? { login: content.assignees.nodes[0].login } : null,
    milestone: content.milestone ?? null,
    type: content.issueType ?? null,
    created_at: content.createdAt ?? "",
    updated_at: content.updatedAt ?? "",
    comments: content.comments?.totalCount ?? 0,
    html_url: externalUrl,
  };

  return {
    integrationId: INTEGRATION_ID,
    externalId: String(content.number),
    externalUrl,
    title: content.title ?? "",
    body: content.body ?? null,
    currentState: state,
    allowedTransitions: transitionsForState(state),
    assignees,
    labels: (content.labels?.nodes ?? []).map((l) => l.name),
    issueType: content.issueType?.name ?? null,
    blocks: [],
    blockedBy: [],
    updatedAt: content.updatedAt ?? "",
    raw,
  };
}

/**
 * Walks the recursive blockedBy graph from a batched GraphQL response,
 * filtering closed issues and breaking cycles. Verbatim port of the depth-3
 * walk in server/services/github.ts.
 */
export function flattenBlockers(
  nodes: BlockedByNode[],
  depth: number,
  seen: Set<number>,
): Array<{ number: number; title: string }> {
  if (depth === 0) return [];
  const result: Array<{ number: number; title: string }> = [];
  for (const node of nodes) {
    if (node.state !== "OPEN" || seen.has(node.number)) continue;
    seen.add(node.number);
    result.push({ number: node.number, title: node.title });
    if (node.blockedBy?.nodes) {
      result.push(...flattenBlockers(node.blockedBy.nodes, depth - 1, seen));
    }
  }
  return result;
}

export function openBlocks(nodes: BlockingNode[]): Array<{ number: number; title: string }> {
  return nodes.filter((n) => n.state === "OPEN").map((n) => ({ number: n.number, title: n.title }));
}
