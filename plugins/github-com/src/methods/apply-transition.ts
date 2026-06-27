import { parseExternalId } from "../external-id.js";
import { githubRequest, parseRepo } from "../github-request.js";

const TRANSITION_TO_STATE: Record<string, "closed" | "open"> = {
  close: "closed",
  reopen: "open",
};

export async function applyTransition(params: {
  externalId: string;
  transition: string;
}): Promise<void> {
  const state = TRANSITION_TO_STATE[params.transition];
  if (!state) {
    throw new Error(
      `[github-com] Unknown transition "${params.transition}". Expected "close" or "reopen".`,
    );
  }
  const { repoFullName, issueNumber } = parseExternalId(params.externalId);
  const { owner, repo } = parseRepo(repoFullName);
  await githubRequest({
    kind: "rest",
    route: "PATCH /repos/{owner}/{repo}/issues/{issue_number}",
    params: { owner, repo, issue_number: issueNumber, state },
  });
}
