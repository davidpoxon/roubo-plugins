import type { NormalizedComment } from "@roubo/plugin-sdk";
import { parseGithubIssueExternalId } from "../shared/index.js";
import { fetchIssueComments } from "../github-fetchers.js";
import { rawToNormalizedComment } from "../normalize.js";

export async function getComments(params: { externalId: string }): Promise<NormalizedComment[]> {
  const { repoFullName, issueNumber } = parseGithubIssueExternalId(params.externalId);
  const raw = await fetchIssueComments(repoFullName, issueNumber);
  return raw.map(rawToNormalizedComment);
}
