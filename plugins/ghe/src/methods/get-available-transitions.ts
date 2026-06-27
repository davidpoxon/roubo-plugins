import { parseExternalId } from "../external-id.js";
import { fetchIssueDetail } from "../github-fetchers.js";

/**
 * GitHub's transitions are derived from issue state: "close" if open,
 * "reopen" if closed. The legacy server-side code did not model
 * transitions explicitly because it only mutated state through the
 * Octokit `update` call, not a generic transition map. The plugin
 * surfaces them as a small string vocabulary the host can render.
 */
export async function getAvailableTransitions(params: { externalId: string }): Promise<string[]> {
  const { repoFullName, issueNumber } = parseExternalId(params.externalId);
  const raw = await fetchIssueDetail(repoFullName, issueNumber);
  const state = (raw.state ?? "open").toLowerCase();
  return state === "open" ? ["close"] : ["reopen"];
}
