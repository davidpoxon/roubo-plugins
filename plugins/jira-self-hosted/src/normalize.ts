import type { NormalizedComment, NormalizedIssue } from "@roubo/plugin-sdk";
import { adfToMarkdown } from "./adf-to-markdown.js";
import type { JiraPluginConfig } from "./config.js";
import { mapLinkType, type JiraIssueLink } from "./link-types.js";

const PLUGIN_ID = "jira-self-hosted";

export interface JiraUserRef {
  accountId?: string;
  key?: string;
  name?: string;
  displayName?: string;
}

export interface JiraTransition {
  id?: string;
  name?: string;
}

export interface JiraIssueResponse {
  key: string;
  fields?: {
    summary?: string;
    description?: unknown;
    status?: { name?: string };
    issuelinks?: JiraIssueLink[];
    assignee?: JiraUserRef | null;
    labels?: string[];
    issuetype?: { name?: string };
    updated?: string;
  };
  transitions?: JiraTransition[];
}

export function normalizeIssue(
  config: JiraPluginConfig,
  issue: JiraIssueResponse,
  instance: string,
): NormalizedIssue {
  const fields = issue.fields ?? {};
  const blocks: string[] = [];
  const blockedBy: string[] = [];

  for (const link of fields.issuelinks ?? []) {
    const mapped = mapLinkType(config, link);
    if (!mapped) continue;
    if (mapped.kind === "blocks") blocks.push(mapped.externalId);
    else blockedBy.push(mapped.externalId);
  }

  const assignee = fields.assignee;
  const assignees =
    assignee && (assignee.accountId || assignee.key || assignee.name)
      ? [
          {
            externalId: assignee.accountId ?? assignee.key ?? assignee.name ?? "",
            displayName: assignee.displayName ?? "",
          },
        ]
      : [];

  const allowedTransitions = (issue.transitions ?? [])
    .map((t) => t.name?.trim())
    .filter((name): name is string => typeof name === "string" && name.length > 0);

  return {
    integrationId: PLUGIN_ID,
    externalId: issue.key,
    externalUrl: `${instance}/browse/${encodeURIComponent(issue.key)}`,
    title: fields.summary ?? issue.key,
    body: renderBody(fields.description),
    currentState: fields.status?.name ?? "Unknown",
    allowedTransitions,
    assignees,
    labels: Array.isArray(fields.labels) ? fields.labels.slice() : [],
    issueType: fields.issuetype?.name ?? null,
    blocks,
    blockedBy,
    updatedAt: fields.updated ?? new Date(0).toISOString(),
    raw: issue,
  };
}

export function normalizeComment(comment: JiraCommentResponse): NormalizedComment {
  const author = comment.author ?? {};
  return {
    externalId: String(comment.id ?? ""),
    author: {
      externalId: author.accountId ?? author.key ?? author.name ?? "",
      displayName: author.displayName ?? "",
    },
    body: renderBody(comment.body) ?? "",
    createdAt: comment.created ?? new Date(0).toISOString(),
    updatedAt: comment.updated ?? comment.created ?? new Date(0).toISOString(),
  };
}

export interface JiraCommentResponse {
  id?: string;
  body?: unknown;
  author?: JiraUserRef;
  created?: string;
  updated?: string;
}

function renderBody(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input === "string") return input.length > 0 ? input : null;
  const md = adfToMarkdown(input);
  return md.length > 0 ? md : null;
}
