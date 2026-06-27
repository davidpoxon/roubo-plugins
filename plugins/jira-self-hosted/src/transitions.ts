import { jiraFetch, JiraApiError, type JiraRequestContext } from "./jira-client.js";
import type { JiraTransition } from "./normalize.js";

interface TransitionsResponse {
  transitions?: JiraTransition[];
}

export async function getAvailableTransitions(
  ctx: JiraRequestContext,
  externalId: string,
): Promise<string[]> {
  const data = await jiraFetch<TransitionsResponse>(
    ctx,
    `/rest/api/2/issue/${encodeURIComponent(externalId)}/transitions`,
  );
  return (data.transitions ?? [])
    .map((t) => t.name?.trim())
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

export async function applyTransition(
  ctx: JiraRequestContext,
  externalId: string,
  transitionName: string,
): Promise<void> {
  const lookup = await jiraFetch<TransitionsResponse>(
    ctx,
    `/rest/api/2/issue/${encodeURIComponent(externalId)}/transitions`,
  );
  const match = (lookup.transitions ?? []).find(
    (t) => typeof t.name === "string" && t.name.trim() === transitionName.trim(),
  );
  if (!match || typeof match.id !== "string") {
    throw new JiraApiError(
      `Transition "${transitionName}" is not available on issue ${externalId}.`,
      404,
      "",
    );
  }
  await jiraFetch<unknown>(ctx, `/rest/api/2/issue/${encodeURIComponent(externalId)}/transitions`, {
    method: "POST",
    body: { transition: { id: match.id } },
  });
}
