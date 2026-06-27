import { parseExternalId } from "../external-id.js";
import { fetchIssueDetail } from "../github-fetchers.js";
import { githubRequest, parseRepo } from "../github-request.js";

function currentAssignees(raw: { assignees?: Array<{ login: string } | null> | null }): string[] {
  return (raw.assignees ?? [])
    .map((a) => a?.login)
    .filter((login): login is string => typeof login === "string" && login.length > 0);
}

export async function assignIssue(params: {
  externalId: string;
  assigneeExternalId: string;
}): Promise<void> {
  const { repoFullName, issueNumber } = parseExternalId(params.externalId);
  const { owner, repo } = parseRepo(repoFullName);
  const raw = await fetchIssueDetail(repoFullName, issueNumber);
  const existing = currentAssignees(raw);
  const nextAssignees = existing.includes(params.assigneeExternalId)
    ? existing
    : [...existing, params.assigneeExternalId];
  await githubRequest({
    kind: "rest",
    route: "PATCH /repos/{owner}/{repo}/issues/{issue_number}",
    params: { owner, repo, issue_number: issueNumber, assignees: nextAssignees },
  });
}
