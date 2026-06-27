import type { CreateIssueResult } from "@roubo/plugin-sdk";
import { formatExternalId } from "../external-id.js";
import { githubRequest, parseRepo } from "../github-request.js";

// The slice of GitHub's `POST /repos/{owner}/{repo}/issues` response the gateway
// needs. GitHub returns the full issue object; we read only the number, html_url,
// and node_id and discard the rest.
interface CreateIssueResponse {
  number: number;
  html_url: string;
  node_id: string;
}

/**
 * Create a GitHub issue (verify-gate FR-011, spike #704). Uses the REST
 * `POST /repos/{owner}/{repo}/issues` endpoint, which avoids the node-id
 * round-trip the GraphQL `createIssue` mutation needs while still returning the
 * created issue's `node_id` (used to wire blocking links without a second
 * lookup). Mirrors the existing privileged-write methods (`assign-issue.ts`,
 * `apply-transition.ts`) that go through the same `githubRequest` REST arm.
 *
 * This plugin method is only reached through the host's TrackerActionGateway,
 * which gates the call on the `supportsCreateIssue` manifest capability and the
 * plugin's consent before invoking it.
 */
export async function createIssue(params: {
  repoFullName: string;
  title: string;
  body?: string;
  labels?: string[];
}): Promise<CreateIssueResult> {
  const { owner, repo } = parseRepo(params.repoFullName);
  if (params.title.trim().length === 0) {
    throw new Error("[github-com] createIssue requires a non-empty title.");
  }
  const result = await githubRequest<CreateIssueResponse>({
    kind: "rest",
    route: "POST /repos/{owner}/{repo}/issues",
    params: {
      owner,
      repo,
      title: params.title,
      ...(params.body !== undefined ? { body: params.body } : {}),
      ...(params.labels && params.labels.length > 0 ? { labels: params.labels } : {}),
    },
  });
  const issue = result.data;
  return {
    ref: formatExternalId(params.repoFullName, issue.number),
    url: issue.html_url,
    nodeId: issue.node_id,
  };
}
