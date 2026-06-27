import type { NormalizedIssue } from "@roubo/plugin-sdk";
import { parseGithubExternalId } from "@roubo/shared-github";
import { fetchSingleAlertAsIssue } from "../alerts-runtime.js";
import { formatExternalId } from "../external-id.js";
import { fetchBlockingRelationships, fetchIssueDetail } from "../github-fetchers.js";
import { rawToNormalizedIssue } from "../normalize.js";

export async function getIssue(params: { externalId: string }): Promise<NormalizedIssue> {
  const parsed = parseGithubExternalId(params.externalId);

  // Security alerts (code-scanning, secret-scanning, dependabot) are fetched and
  // redacted inside the plugin; the host only ever sees the redacted clone.
  if (parsed.kind === "alert") {
    return fetchSingleAlertAsIssue(parsed.repoFullName, parsed.category, parsed.alertNumber);
  }

  const { repoFullName, issueNumber } = parsed;
  const raw = await fetchIssueDetail(repoFullName, issueNumber);
  const blocking = await fetchBlockingRelationships(repoFullName, [issueNumber]);

  const issue = rawToNormalizedIssue(raw, {
    blockedBy: (blocking.blockedBy[issueNumber] ?? []).map((b) =>
      formatExternalId(repoFullName, b.number),
    ),
    blocks: (blocking.blocks[issueNumber] ?? []).map((b) =>
      formatExternalId(repoFullName, b.number),
    ),
  });
  issue.externalId = formatExternalId(repoFullName, issueNumber);
  return issue;
}
