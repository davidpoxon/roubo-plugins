import type { NormalizedComment } from "@roubo/plugin-sdk";
import { parseExternalId } from "../external-id.js";
import { fetchIssueComments } from "../github-fetchers.js";
import { rawToNormalizedComment } from "../normalize.js";

export async function getComments(params: { externalId: string }): Promise<NormalizedComment[]> {
  const { repoFullName, issueNumber } = parseExternalId(params.externalId);
  const raw = await fetchIssueComments(repoFullName, issueNumber);
  return raw.map(rawToNormalizedComment);
}
